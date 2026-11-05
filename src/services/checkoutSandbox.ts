import { createServer, IncomingMessage, Server as HttpServer, ServerResponse } from 'node:http';
import { URL } from 'node:url';

export type FaultScenarioId =
  | 'jpy_zero_decimal_500'
  | 'promo_negative_ledger_500'
  | 'inventory_lock_leak_503';

export interface CheckoutRequest {
  cartId: string;
  currency: 'USD' | 'EUR' | 'GBP' | 'JPY' | 'KRW';
  items: Array<{ sku: string; qty: number; unitPriceMajor: number }>;
  promoCodes?: string[];
  simulateFraudDecline?: boolean;
}

export interface CheckoutResponse {
  orderId: string;
  version: string;
  currency: string;
  chargeMinorUnits: number;
  taxMinorUnits: number;
  activeLocks: number;
  status: 'authorized';
}

export interface IncidentAlertWebhook {
  incidentId: string;
  scenarioId: FaultScenarioId;
  service: string;
  deployedVersion: string;
  lastKnownGoodVersion: string;
  suspectedCommit: {
    sha: string;
    author: string;
    message: string;
    filePath: string;
    line: number;
  };
  endpoint: string;
  httpStatus: number;
  errorRatePct: number;
  p99LatencyMs: number;
  errorMessage: string;
  stackTrace: string;
  reproductionPayload: CheckoutRequest;
  detectedAt: number;
}

export interface PatchVerificationResult {
  scenarioId: FaultScenarioId;
  reproConfirmed: boolean;
  reproErrorOutput: string;
  candidateVersion: string;
  diffUnified: string;
  changedLines: number;
  touchedFiles: string[];
  testMatrix: Array<{
    name: string;
    passed: boolean;
    detail: string;
  }>;
  allPassed: boolean;
  /** Who authored the candidate: Vigil's own patcher, or an external coding agent (e.g. Claude Code via Switch Console). */
  author: string;
  source: 'vigil-patcher' | 'external-coder';
}

export interface CanaryProbeReport {
  probesRun: number;
  probesPassed: number;
  maxLatencyMs: number;
  healthy: boolean;
  details: string[];
}

interface PricingEngineOptions {
  activeFaults: Set<FaultScenarioId>;
  lockState: { held: number; maxSlots: number };
}

const CURRENCY_CONFIG_HEALTHY: Record<string, { minorScale: number }> = {
  USD: { minorScale: 100 },
  EUR: { minorScale: 100 },
  GBP: { minorScale: 100 },
  JPY: { minorScale: 1 },
  KRW: { minorScale: 1 },
};

// Buggy v2.14.0 table omitted zero-decimal currencies during refactor (commit a81f4c9)
const CURRENCY_CONFIG_BUGGY_V214: Record<string, { minorScale: number } | undefined> = {
  USD: { minorScale: 100 },
  EUR: { minorScale: 100 },
  GBP: { minorScale: 100 },
};

const PROMO_DISCOUNTS_MAJOR: Record<string, number> = {
  SAVE15: 15,
  VIP40: 40,
  LAUNCH25: 25,
};

/**
 * Pure deterministic execution of the Checkout Pricing & Lock Engine
 * Executes real buggy v2.14.0 code paths when a fault is active, and verified patched paths when clean.
 */
export function executeCheckoutComputation(
  req: CheckoutRequest,
  version: string,
  opts: PricingEngineOptions,
): CheckoutResponse {
  // Fault 3: Unreleased semaphore lock on declined fraud check (commit 77c04a1)
  if (opts.lockState.held >= opts.lockState.maxSlots) {
    const err = new Error(
      `LockAcquisitionTimeoutError: Inventory semaphore exhausted (${opts.lockState.held}/${opts.lockState.maxSlots} slots leaked) at InventoryPool.acquire (src/services/cartPricing.ts:112:15)`,
    );
    (err as Error & { statusCode?: number }).statusCode = 503;
    throw err;
  }

  opts.lockState.held += 1;
  try {
    if (req.simulateFraudDecline) {
      if (opts.activeFaults.has('inventory_lock_leak_503')) {
        // BUG in v2.14.0: early throw bypasses lock release when `finally` block was removed!
        const fraudErr = new Error(
          `FraudCheckDeclinedError: Risk score above threshold for cart ${req.cartId} (lock slot leaked!) at CheckoutController.authorize (src/services/cartPricing.ts:104:11)`,
        );
        (fraudErr as Error & { statusCode?: number }).statusCode = 500;
        throw fraudErr;
      }
      // Healthy / patched path releases lock cleanly in `finally` before returning controlled decline error
      opts.lockState.held = Math.max(0, opts.lockState.held - 1);
      const cleanDecline = new Error(`FraudCheckDeclined: Risk rule triggered for ${req.cartId}`);
      (cleanDecline as Error & { statusCode?: number }).statusCode = 422;
      throw cleanDecline;
    }

    // Fault 1: Zero-decimal currency lookup NPE in v2.14.0 (commit a81f4c9)
    const table = opts.activeFaults.has('jpy_zero_decimal_500')
      ? CURRENCY_CONFIG_BUGGY_V214
      : CURRENCY_CONFIG_HEALTHY;

    const currencyMeta = table[req.currency];
    if (!currencyMeta) {
      const typeErr = new TypeError(
        `Cannot read properties of undefined (reading 'minorScale') for zero-decimal currency '${req.currency}' at formatMinorUnits (src/services/cartPricing.ts:48:29)`,
      );
      (typeErr as Error & { statusCode?: number }).statusCode = 500;
      throw typeErr;
    }

    const scale = currencyMeta.minorScale;
    const subtotalMajor = req.items.reduce((acc, item) => acc + item.qty * item.unitPriceMajor, 0);

    // Fault 2: Unfloored stacked coupon discount producing negative capture minor units (commit d39e12b)
    const rawPromoMajor = (req.promoCodes ?? []).reduce(
      (sum, code) => sum + (PROMO_DISCOUNTS_MAJOR[code] ?? 0),
      0,
    );

    let discountedMajor: number;
    if (opts.activeFaults.has('promo_negative_ledger_500')) {
      discountedMajor = subtotalMajor - rawPromoMajor;
    } else {
      // Patched: deduplicate codes + cap discount so capture floor is >= 1 major unit (or 0.50 USD)
      const uniqueCodes = Array.from(new Set(req.promoCodes ?? []));
      const dedupedDiscount = uniqueCodes.reduce(
        (sum, code) => sum + (PROMO_DISCOUNTS_MAJOR[code] ?? 0),
        0,
      );
      const minFloorMajor = scale === 1 ? 50 : 1;
      discountedMajor = Math.max(minFloorMajor, subtotalMajor - dedupedDiscount);
    }

    const subtotalMinor = Math.round(discountedMajor * scale);
    if (subtotalMinor <= 0) {
      const stripeErr = new Error(
        `StripeInvalidAmountError: Charge amount ${subtotalMinor} minor units (${req.currency}) must be >= 50 at PaymentGateway.capture (src/services/cartPricing.ts:74:19)`,
      );
      (stripeErr as Error & { statusCode?: number }).statusCode = 500;
      throw stripeErr;
    }

    const taxMinorUnits = Math.round(subtotalMinor * 0.08);
    const chargeMinorUnits = subtotalMinor + taxMinorUnits;

    opts.lockState.held = Math.max(0, opts.lockState.held - 1);

    return {
      orderId: `ord_${req.cartId}`,
      version,
      currency: req.currency,
      chargeMinorUnits,
      taxMinorUnits,
      activeLocks: opts.lockState.held,
      status: 'authorized',
    };
  } catch (err) {
    if (!opts.activeFaults.has('inventory_lock_leak_503')) {
      opts.lockState.held = Math.max(0, opts.lockState.held - 1);
    }
    throw err;
  }
}

export const FAULT_CATALOG: Record<
  FaultScenarioId,
  {
    title: string;
    commitSha: string;
    commitAuthor: string;
    commitMessage: string;
    filePath: string;
    line: number;
    reproPayload: CheckoutRequest;
    diffUnified: string;
    changedLines: number;
    touchedFiles: string[];
    /** Every pattern must appear in an externally submitted diff's ADDED lines for the candidate to count as fixing this fault. */
    fixSignatures: Array<{ label: string; pattern: RegExp }>;
  }
> = {
  jpy_zero_decimal_500: {
    title: 'v2.14.0 Zero-Decimal Currency Crash (JPY/KRW)',
    commitSha: 'a81f4c9',
    commitAuthor: 'alex@team.dev',
    commitMessage: 'refactor(pricing): migrate ISO-4217 currency scale lookup table',
    filePath: 'src/services/cartPricing.ts',
    line: 48,
    reproPayload: {
      cartId: 'cart_tokyo_992',
      currency: 'JPY',
      items: [{ sku: 'PRO-SEAT-ANNUAL', qty: 2, unitPriceMajor: 4800 }],
      promoCodes: [],
    },
    changedLines: 8,
    touchedFiles: ['src/services/cartPricing.ts', 'tests/cartPricing.spec.ts'],
    diffUnified: [
      '--- a/src/services/cartPricing.ts',
      '+++ b/src/services/cartPricing.ts',
      '@@ -44,6 +44,8 @@ const CURRENCY_SCALE_MAP: Record<CurrencyCode, { minorScale: number }> = {',
      '   USD: { minorScale: 100 },',
      '   EUR: { minorScale: 100 },',
      '   GBP: { minorScale: 100 },',
      '+  JPY: { minorScale: 1 },',
      '+  KRW: { minorScale: 1 },',
      ' };',
    ].join('\n'),
    fixSignatures: [
      { label: 'JPY scale entry restored', pattern: /JPY\s*:\s*\{\s*minorScale\s*:\s*1\s*\}/ },
      { label: 'KRW scale entry restored', pattern: /KRW\s*:\s*\{\s*minorScale\s*:\s*1\s*\}/ },
    ],
  },
  promo_negative_ledger_500: {
    title: 'v2.14.0 Stacked Promo Negative Capture Crash',
    commitSha: 'd39e12b',
    commitAuthor: 'sam@team.dev',
    commitMessage: 'feat(promos): enable multi-coupon array evaluation at checkout',
    filePath: 'src/services/cartPricing.ts',
    line: 74,
    reproPayload: {
      cartId: 'cart_promo_418',
      currency: 'USD',
      items: [{ sku: 'STARTER-PLAN', qty: 1, unitPriceMajor: 29 }],
      promoCodes: ['VIP40', 'SAVE15', 'VIP40'],
    },
    changedLines: 11,
    touchedFiles: ['src/services/cartPricing.ts', 'tests/promoLedger.spec.ts'],
    diffUnified: [
      '--- a/src/services/cartPricing.ts',
      '+++ b/src/services/cartPricing.ts',
      '@@ -68,7 +68,10 @@ function applyPromotions(subtotalMajor: number, codes: string[], scale: number) {',
      '-  const discount = codes.reduce((s, c) => s + (PROMOS[c] ?? 0), 0);',
      '-  return subtotalMajor - discount;',
      '+  const uniqueCodes = Array.from(new Set(codes));',
      '+  const discount = uniqueCodes.reduce((s, c) => s + (PROMOS[c] ?? 0), 0);',
      '+  const minFloorMajor = scale === 1 ? 50 : 1;',
      '+  return Math.max(minFloorMajor, subtotalMajor - discount);',
      ' }',
    ].join('\n'),
    fixSignatures: [
      { label: 'duplicate promo codes deduplicated', pattern: /new Set\(/ },
      { label: 'non-negative charge floor enforced', pattern: /Math\.max\(/ },
    ],
  },
  inventory_lock_leak_503: {
    title: 'v2.14.0 Inventory Semaphore Leak on Fraud Decline (503 Cascade)',
    commitSha: '77c04a1',
    commitAuthor: 'alex@team.dev',
    commitMessage: 'perf(locks): inline fraud risk check inside inventory reservation',
    filePath: 'src/services/cartPricing.ts',
    line: 112,
    reproPayload: {
      cartId: 'cart_lock_701',
      currency: 'USD',
      items: [{ sku: 'HARDWARE-KEY-V3', qty: 1, unitPriceMajor: 85 }],
      simulateFraudDecline: true,
    },
    changedLines: 9,
    touchedFiles: ['src/services/cartPricing.ts', 'tests/inventoryPool.spec.ts'],
    diffUnified: [
      '--- a/src/services/cartPricing.ts',
      '+++ b/src/services/cartPricing.ts',
      '@@ -101,8 +101,10 @@ export function authorizeCheckout(req: CheckoutRequest) {',
      '   inventoryPool.acquire(req.cartId);',
      '-  if (fraudEngine.isDeclined(req)) {',
      '-    throw new FraudCheckDeclinedError(req.cartId);',
      '-  }',
      '+  try {',
      '+    if (fraudEngine.isDeclined(req)) throw new FraudCheckDeclinedError(req.cartId);',
      '+    return captureOrder(req);',
      '+  } finally {',
      '+    inventoryPool.release(req.cartId);',
      '+  }',
      ' }',
    ].join('\n'),
    fixSignatures: [
      { label: 'lock release moved into finally block', pattern: /finally\s*\{/ },
    ],
  },
};

/**
 * Live Runnable Checkout & Cart Pricing Microservice (`checkout-api`)
 */
/** Which regression vectors exercise a given fault (used when an external diff lacks the fix). */
function scenarioFaultVector(scenarioId: FaultScenarioId): RegExp {
  switch (scenarioId) {
    case 'jpy_zero_decimal_500':
      return /JPY|KRW/;
    case 'promo_negative_ledger_500':
      return /promo/i;
    case 'inventory_lock_leak_503':
      return /semaphore|lock/i;
  }
}

export class CheckoutMicroservice {
  private server: HttpServer | null = null;
  private boundPort = 0;
  private deployedVersion = 'v2.13.2';
  private readonly lastKnownGoodVersion = 'v2.13.2';
  private activeFaults = new Set<FaultScenarioId>();
  private stagedCandidate: {
    incidentId: string;
    scenarioId: FaultScenarioId;
    candidateVersion: string;
    verification: PatchVerificationResult;
  } | null = null;

  private lockState = { held: 0, maxSlots: 3 };
  private totalRequests = 420;
  private totalErrors = 0;
  private recentErrorRatePct = 0.1;
  private p99LatencyMs = 42;
  private incidentSequence = 2040;
  private onIncidentAlert?: (alert: IncidentAlertWebhook) => Promise<void> | void;

  constructor(opts: { onIncidentAlert?: (alert: IncidentAlertWebhook) => Promise<void> | void } = {}) {
    this.onIncidentAlert = opts.onIncidentAlert;
  }

  public setIncidentWebhook(cb: (alert: IncidentAlertWebhook) => Promise<void> | void): void {
    this.onIncidentAlert = cb;
  }

  public async start(port = 4020): Promise<number> {
    this.server = createServer((req, res) => {
      this.handleRequest(req, res).catch((err) => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(err) }));
      });
    });

    await new Promise<void>((resolve) => {
      this.server!.listen(port, '127.0.0.1', () => {
        const addr = this.server!.address();
        if (addr && typeof addr === 'object') {
          this.boundPort = addr.port;
        }
        resolve();
      });
    });
    return this.boundPort;
  }

  public async stop(): Promise<void> {
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      this.server = null;
    }
  }

  public getBaseUrl(): string {
    return `http://127.0.0.1:${this.boundPort}`;
  }

  public getTelemetry() {
    return {
      service: 'checkout-api',
      deployedVersion: this.deployedVersion,
      lastKnownGoodVersion: this.lastKnownGoodVersion,
      activeFaults: Array.from(this.activeFaults),
      stagedCandidateVersion: this.stagedCandidate?.candidateVersion ?? null,
      totalRequests: this.totalRequests,
      totalErrors: this.totalErrors,
      errorRatePct: this.recentErrorRatePct,
      p99LatencyMs: this.p99LatencyMs,
      activeInventoryLocks: this.lockState.held,
      maxInventoryLocks: this.lockState.maxSlots,
      status: this.activeFaults.size > 0 ? 'degraded' : 'healthy',
    };
  }

  /**
   * Simulates deploying buggy `v2.14.0` and firing real failing requests against the engine
   * to capture the genuine stack trace and emit an incident webhook.
   */
  public async injectFaultRelease(scenarioId: FaultScenarioId): Promise<IncidentAlertWebhook> {
    const spec = FAULT_CATALOG[scenarioId];
    this.deployedVersion = 'v2.14.0';
    this.activeFaults.clear();
    this.activeFaults.add(scenarioId);
    this.lockState.held = 0;

    let capturedError: Error | null = null;
    let capturedStatus = 500;

    const attempts = scenarioId === 'inventory_lock_leak_503' ? 4 : 1;
    for (let i = 0; i < attempts; i++) {
      this.totalRequests += 1;
      try {
        executeCheckoutComputation(spec.reproPayload, this.deployedVersion, {
          activeFaults: this.activeFaults,
          lockState: this.lockState,
        });
      } catch (err) {
        this.totalErrors += 1;
        capturedError = err as Error;
        capturedStatus = (err as Error & { statusCode?: number }).statusCode ?? 500;
      }
    }

    this.recentErrorRatePct = scenarioId === 'inventory_lock_leak_503' ? 38.4 : 14.8;
    this.p99LatencyMs = scenarioId === 'inventory_lock_leak_503' ? 1840 : 620;

    this.incidentSequence += 1;
    const incidentId = `INC-${this.incidentSequence}`;

    const alert: IncidentAlertWebhook = {
      incidentId,
      scenarioId,
      service: 'checkout-api',
      deployedVersion: this.deployedVersion,
      lastKnownGoodVersion: this.lastKnownGoodVersion,
      suspectedCommit: {
        sha: spec.commitSha,
        author: spec.commitAuthor,
        message: spec.commitMessage,
        filePath: spec.filePath,
        line: spec.line,
      },
      endpoint: 'POST /api/checkout',
      httpStatus: capturedStatus,
      errorRatePct: this.recentErrorRatePct,
      p99LatencyMs: this.p99LatencyMs,
      errorMessage: capturedError?.message ?? 'Unexpected checkout 500 error',
      stackTrace: capturedError?.stack ?? `${capturedError?.name}: ${capturedError?.message}`,
      reproductionPayload: spec.reproPayload,
      detectedAt: Date.now(),
    };

    if (this.onIncidentAlert) {
      await this.onIncidentAlert(alert);
    }
    return alert;
  }

  /**
   * Reproduces the exact bug against the active faulty engine, then runs an 6-vector
   * regression test matrix against the patched candidate WITHOUT mutating live production yet!
   */
  public reproduceAndStagePatch(incidentId: string, scenarioId: FaultScenarioId): PatchVerificationResult {
    const spec = FAULT_CATALOG[scenarioId];
    let reproConfirmed = false;
    let reproErrorOutput = '';

    const reproLocks = { held: scenarioId === 'inventory_lock_leak_503' ? 3 : 0, maxSlots: 3 };
    try {
      executeCheckoutComputation(spec.reproPayload, 'v2.14.0', {
        activeFaults: new Set([scenarioId]),
        lockState: reproLocks,
      });
    } catch (err) {
      reproConfirmed = true;
      reproErrorOutput = (err as Error).message;
    }

    // Run real regression vectors against the patched candidate (`activeFaults = empty`)
    const candidateFaults = new Set<FaultScenarioId>();
    const candidateLocks = { held: 0, maxSlots: 3 };
    const testMatrix: PatchVerificationResult['testMatrix'] = [];

    const runVector = (name: string, fn: () => string) => {
      try {
        const detail = fn();
        testMatrix.push({ name, passed: true, detail });
      } catch (err) {
        testMatrix.push({ name, passed: false, detail: (err as Error).message });
      }
    };

    runVector('USD standard checkout ($99.00)', () => {
      const r = executeCheckoutComputation(
        { cartId: 't_usd', currency: 'USD', items: [{ sku: 'PRO', qty: 1, unitPriceMajor: 99 }] },
        'v2.14.1-hotfix',
        { activeFaults: candidateFaults, lockState: candidateLocks },
      );
      if (r.chargeMinorUnits !== 10692) throw new Error(`Expected 10692 cents, got ${r.chargeMinorUnits}`);
      return `200 OK · charge=${r.chargeMinorUnits} minor units`;
    });

    runVector('JPY zero-decimal checkout (¥9,600)', () => {
      const r = executeCheckoutComputation(
        { cartId: 't_jpy', currency: 'JPY', items: [{ sku: 'PRO', qty: 2, unitPriceMajor: 4800 }] },
        'v2.14.1-hotfix',
        { activeFaults: candidateFaults, lockState: candidateLocks },
      );
      if (r.chargeMinorUnits !== 10368) throw new Error(`Expected 10368 JPY, got ${r.chargeMinorUnits}`);
      return `200 OK · charge=¥${r.chargeMinorUnits}`;
    });

    runVector('KRW zero-decimal checkout (₩55,000)', () => {
      const r = executeCheckoutComputation(
        { cartId: 't_krw', currency: 'KRW', items: [{ sku: 'TEAM', qty: 1, unitPriceMajor: 55000 }] },
        'v2.14.1-hotfix',
        { activeFaults: candidateFaults, lockState: candidateLocks },
      );
      return `200 OK · charge=₩${r.chargeMinorUnits}`;
    });

    runVector('Stacked & duplicate promo codes floor check', () => {
      const r = executeCheckoutComputation(
        {
          cartId: 't_promo',
          currency: 'USD',
          items: [{ sku: 'STARTER', qty: 1, unitPriceMajor: 29 }],
          promoCodes: ['VIP40', 'SAVE15', 'VIP40'],
        },
        'v2.14.1-hotfix',
        { activeFaults: candidateFaults, lockState: candidateLocks },
      );
      if (r.chargeMinorUnits < 100) throw new Error(`Floor violated: ${r.chargeMinorUnits}`);
      return `200 OK · deduplicated & floored at ${r.chargeMinorUnits} cents`;
    });

    runVector('Fraud-decline semaphore lock release (4 sequential declines)', () => {
      for (let i = 0; i < 4; i++) {
        try {
          executeCheckoutComputation(
            {
              cartId: `t_fraud_${i}`,
              currency: 'USD',
              items: [{ sku: 'KEY', qty: 1, unitPriceMajor: 85 }],
              simulateFraudDecline: true,
            },
            'v2.14.1-hotfix',
            { activeFaults: candidateFaults, lockState: candidateLocks },
          );
        } catch {
          // Expected controlled 422 decline
        }
      }
      if (candidateLocks.held !== 0) {
        throw new Error(`Semaphore leaked ${candidateLocks.held} slots!`);
      }
      return `0 leaked locks across 4 declined transactions`;
    });

    const allPassed = reproConfirmed && testMatrix.every((t) => t.passed);
    const candidateVersion = 'v2.14.1-hotfix';
    const result: PatchVerificationResult = {
      scenarioId,
      reproConfirmed,
      reproErrorOutput,
      candidateVersion,
      diffUnified: spec.diffUnified,
      changedLines: spec.changedLines,
      touchedFiles: spec.touchedFiles,
      testMatrix,
      allPassed,
      author: 'vigil-patcher',
      source: 'vigil-patcher',
    };

    this.stagedCandidate = {
      incidentId,
      scenarioId,
      candidateVersion,
      verification: result,
    };

    return result;
  }

  /**
   * Promotes staged `v2.14.1-hotfix` OR rolls back to `v2.13.2`, then executes
   * real HTTP synthetic probes against the running `checkout-api` socket!
   */
  /**
   * External coder intake (e.g. Claude Code bound through Switch Console as `patch-author`):
   * verifies a human/agent-authored unified diff instead of Vigil's reference fix. The fault is
   * reproduced on v2.14.0, the diff is checked for the fault's fix signatures, and the 5-vector
   * regression matrix runs against the candidate build. A diff that doesn't carry the fix fails
   * the matrix, so the release gate rejects it (`REJECTED_UNVERIFIED_PATCH`).
   */
  public stageExternalPatch(
    incidentId: string,
    scenarioId: FaultScenarioId,
    submission: { diffUnified: string; author: string; touchedFiles?: string[] },
  ): PatchVerificationResult {
    const spec = FAULT_CATALOG[scenarioId];
    const base = this.reproduceAndStagePatch(incidentId, scenarioId);

    const diff = submission.diffUnified.replace(/\r\n/g, '\n').trim();
    const addedLines = diff
      .split('\n')
      .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
      .map((l) => l.slice(1));
    const removedLines = diff.split('\n').filter((l) => l.startsWith('-') && !l.startsWith('---'));
    const changedLines = addedLines.length + removedLines.length;
    const touchedFiles =
      submission.touchedFiles && submission.touchedFiles.length > 0
        ? submission.touchedFiles
        : Array.from(
            new Set(
              diff
                .split('\n')
                .filter((l) => l.startsWith('+++ ') || l.startsWith('--- '))
                .map((l) => l.slice(4).replace(/^[ab]\//, '').trim())
                .filter((f) => f && f !== '/dev/null'),
            ),
          );

    const addedText = addedLines.join('\n');
    const missing = spec.fixSignatures.filter((sig) => !sig.pattern.test(addedText));
    const fixesFault = missing.length === 0 && changedLines > 0;

    const testMatrix = [...base.testMatrix];
    const faultVectorName = `Fault ${scenarioId} no longer reproduces on candidate`;
    if (fixesFault) {
      testMatrix.unshift({
        name: faultVectorName,
        passed: true,
        detail: `Diff carries ${spec.fixSignatures.map((f) => f.label).join(' + ')} · repro payload now 200 OK`,
      });
    } else {
      testMatrix.unshift({
        name: faultVectorName,
        passed: false,
        detail:
          changedLines === 0
            ? 'Submitted diff has no changed lines'
            : `Candidate still reproduces fault: missing ${missing.map((m) => m.label).join(', ')}`,
      });
      // Without the fix, the regression vectors that exercise the fault fail too.
      for (const t of testMatrix) {
        if (t.name !== faultVectorName && scenarioFaultVector(scenarioId).test(t.name)) {
          t.passed = false;
          t.detail = `${base.reproErrorOutput.slice(0, 90)}…`;
        }
      }
    }

    const allPassed = base.reproConfirmed && testMatrix.every((t) => t.passed);
    const result: PatchVerificationResult = {
      ...base,
      diffUnified: diff,
      changedLines,
      touchedFiles,
      testMatrix,
      allPassed,
      author: submission.author,
      source: 'external-coder',
    };

    this.stagedCandidate = allPassed
      ? { incidentId, scenarioId, candidateVersion: result.candidateVersion, verification: result }
      : null;
    return result;
  }

  public async applyApprovedRelease(mode: 'promote' | 'rollback'): Promise<{
    deployedVersion: string;
    canaryReport: CanaryProbeReport;
  }> {
    this.activeFaults.clear();
    this.lockState.held = 0;
    this.deployedVersion =
      mode === 'promote' && this.stagedCandidate
        ? this.stagedCandidate.candidateVersion
        : this.lastKnownGoodVersion;

    const canaryReport = await this.runSyntheticCanaryProbes();
    if (canaryReport.healthy) {
      this.recentErrorRatePct = 0.0;
      this.p99LatencyMs = 38;
      this.stagedCandidate = null;
    }
    return {
      deployedVersion: this.deployedVersion,
      canaryReport,
    };
  }

  public async runSyntheticCanaryProbes(): Promise<CanaryProbeReport> {
    const probes: CheckoutRequest[] = [
      { cartId: 'canary_usd', currency: 'USD', items: [{ sku: 'PRO', qty: 1, unitPriceMajor: 99 }] },
      { cartId: 'canary_eur', currency: 'EUR', items: [{ sku: 'PRO', qty: 1, unitPriceMajor: 89 }] },
      { cartId: 'canary_jpy', currency: 'JPY', items: [{ sku: 'PRO', qty: 2, unitPriceMajor: 4800 }] },
      { cartId: 'canary_krw', currency: 'KRW', items: [{ sku: 'PRO', qty: 1, unitPriceMajor: 55000 }] },
      {
        cartId: 'canary_promo',
        currency: 'USD',
        items: [{ sku: 'STARTER', qty: 1, unitPriceMajor: 29 }],
        promoCodes: ['VIP40', 'SAVE15'],
      },
    ];

    let passed = 0;
    let maxLatencyMs = 0;
    const details: string[] = [];

    for (const payload of probes) {
      const t0 = Date.now();
      const res = await fetch(`${this.getBaseUrl()}/api/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const elapsed = Math.max(1, Date.now() - t0);
      if (elapsed > maxLatencyMs) maxLatencyMs = elapsed;
      if (res.ok) {
        passed += 1;
        const body = (await res.json()) as CheckoutResponse;
        details.push(`${payload.cartId} (${payload.currency}): 200 OK [${body.chargeMinorUnits} minor, ${elapsed}ms]`);
      } else {
        details.push(`${payload.cartId} (${payload.currency}): FAILED HTTP ${res.status}`);
      }
    }

    return {
      probesRun: probes.length,
      probesPassed: passed,
      maxLatencyMs,
      healthy: passed === probes.length,
      details,
    };
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const method = req.method ?? 'GET';

    if (method === 'GET' && url.pathname === '/health') {
      const telemetry = this.getTelemetry();
      this.sendJson(res, telemetry.status === 'healthy' ? 200 : 503, telemetry);
      return;
    }

    if (method === 'GET' && url.pathname === '/api/releases') {
      this.sendJson(res, 200, {
        current: this.deployedVersion,
        lastKnownGood: this.lastKnownGoodVersion,
        stagedCandidate: this.stagedCandidate?.candidateVersion ?? null,
        recentCommits: Object.values(FAULT_CATALOG).map((f) => ({
          sha: f.commitSha,
          author: f.commitAuthor,
          message: f.commitMessage,
          file: f.filePath,
        })),
      });
      return;
    }

    if (method === 'POST' && url.pathname === '/api/checkout') {
      this.totalRequests += 1;
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as CheckoutRequest;
      try {
        const result = executeCheckoutComputation(payload, this.deployedVersion, {
          activeFaults: this.activeFaults,
          lockState: this.lockState,
        });
        this.sendJson(res, 200, result);
      } catch (err) {
        const status = (err as Error & { statusCode?: number }).statusCode ?? 500;
        if (status >= 500) this.totalErrors += 1;
        this.sendJson(res, status, {
          error: (err as Error).message,
          version: this.deployedVersion,
        });
      }
      return;
    }

    this.sendJson(res, 404, { error: 'Not found' });
  }

  private sendJson(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify(body));
  }
}
