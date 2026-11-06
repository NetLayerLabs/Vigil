/**
 * Live checkout-api target
 *
 * Nothing here is simulated. Vigil owns a git-backed working copy of `services/checkout-api`,
 * runs the service as a real child process, deploys regressions as real commits + restarts,
 * verifies candidates with the service's real test suite and a real staging probe, and promotes
 * or rolls back by moving HEAD and restarting the process. Telemetry is measured by the service
 * from the real request stream (a built-in synthetic traffic generator keeps that stream alive).
 */
import { ChildProcess, spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, IncomingMessage, Server as HttpServer } from 'node:http';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const execFileAsync = promisify(execFile);

export type FaultScenarioId = 'jpy_zero_decimal_500' | 'promo_negative_ledger_500' | 'inventory_lock_leak_503';

export type CurrencyCode = 'USD' | 'EUR' | 'GBP' | 'JPY' | 'KRW';

export interface CheckoutRequest {
  cartId: string;
  currency: CurrencyCode;
  items: Array<{ sku: string; qty: number; unitPriceMajor: number }>;
  promoCodes?: string[];
  simulateFraudDecline?: boolean;
}

export interface IncidentAlertWebhook {
  incidentId: string;
  scenarioId: FaultScenarioId;
  service: string;
  deployedVersion: string;
  lastKnownGoodVersion: string;
  suspectedCommit: { sha: string; author: string; message: string; filePath: string; line: number };
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
  candidateSha: string | null;
  diffUnified: string;
  changedLines: number;
  touchedFiles: string[];
  testMatrix: Array<{ name: string; passed: boolean; detail: string }>;
  allPassed: boolean;
  testRunOutput: string;
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

export interface RepoCommit {
  sha: string;
  author: string;
  message: string;
  at: number;
}

export const LAST_KNOWN_GOOD_VERSION = 'v2.13.2';
export const REGRESSION_VERSION = 'v2.14.0';
export const HOTFIX_VERSION = 'v2.14.1-hotfix';

/**
 * The three seeded regressions. Each is a real patch file under `services/checkout-api/releases`
 * that Vigil applies and commits to the live working copy before restarting the service.
 */
export const FAULT_CATALOG: Record<
  FaultScenarioId,
  {
    title: string;
    commitAuthor: string;
    commitMessage: string;
    patchFile: string;
    reproPayload: CheckoutRequest;
    reproAttempts: number;
    expectedStatus: number;
  }
> = {
  jpy_zero_decimal_500: {
    title: 'v2.14.0 Zero-Decimal Currency Crash (JPY/KRW)',
    commitAuthor: 'Alex Rivera <alex@team.dev>',
    commitMessage: 'refactor(pricing): migrate to shared ISO-4217 scale table (zero-decimal synced lazily)',
    patchFile: 'jpy_zero_decimal_500.patch',
    reproPayload: {
      cartId: 'cart_tokyo_992',
      currency: 'JPY',
      items: [{ sku: 'PRO-SEAT-ANNUAL', qty: 2, unitPriceMajor: 4800 }],
      promoCodes: [],
    },
    reproAttempts: 1,
    expectedStatus: 500,
  },
  promo_negative_ledger_500: {
    title: 'v2.14.0 Stacked Promo Negative Capture Crash',
    commitAuthor: 'Sam Okafor <sam@team.dev>',
    commitMessage: 'feat(promos): honour every submitted coupon in order (marketing PR-4412)',
    patchFile: 'promo_negative_ledger_500.patch',
    reproPayload: {
      cartId: 'cart_promo_418',
      currency: 'USD',
      items: [{ sku: 'STARTER-PLAN', qty: 1, unitPriceMajor: 29 }],
      promoCodes: ['VIP40', 'SAVE15', 'VIP40'],
    },
    reproAttempts: 1,
    expectedStatus: 500,
  },
  inventory_lock_leak_503: {
    title: 'v2.14.0 Inventory Semaphore Leak on Fraud Decline (503 Cascade)',
    commitAuthor: 'Alex Rivera <alex@team.dev>',
    commitMessage: 'perf(locks): screen fraud before the pricing block so declined carts skip tax computation',
    patchFile: 'inventory_lock_leak_503.patch',
    reproPayload: {
      cartId: 'cart_lock_701',
      currency: 'USD',
      items: [{ sku: 'HARDWARE-KEY-V3', qty: 1, unitPriceMajor: 85 }],
      simulateFraudDecline: true,
    },
    reproAttempts: 4,
    expectedStatus: 503,
  },
};

const SYNTHETIC_TRAFFIC: CheckoutRequest[] = [
  { cartId: 'traffic_usd', currency: 'USD', items: [{ sku: 'PRO', qty: 1, unitPriceMajor: 99 }] },
  { cartId: 'traffic_eur', currency: 'EUR', items: [{ sku: 'PRO', qty: 1, unitPriceMajor: 89 }] },
  { cartId: 'traffic_jpy', currency: 'JPY', items: [{ sku: 'PRO', qty: 2, unitPriceMajor: 4800 }] },
  { cartId: 'traffic_gbp', currency: 'GBP', items: [{ sku: 'TEAM', qty: 3, unitPriceMajor: 45 }] },
  { cartId: 'traffic_promo', currency: 'USD', items: [{ sku: 'STARTER', qty: 1, unitPriceMajor: 29 }], promoCodes: ['SAVE15'] },
  { cartId: 'traffic_krw', currency: 'KRW', items: [{ sku: 'PRO', qty: 1, unitPriceMajor: 55000 }] },
];

export interface LiveCheckoutTargetOptions {
  /** Source of truth for the service code (checked into this repo). */
  sourceDir?: string;
  /** Where the git-backed live working copy is created. */
  workDir?: string;
  /** Synthetic traffic interval in ms (0 disables). */
  trafficIntervalMs?: number;
}

export class LiveCheckoutTarget {
  private readonly sourceDir: string;
  private workDir: string;
  private readonly trafficIntervalMs: number;

  private child: ChildProcess | null = null;
  private boundPort = 0;
  private alertServer: HttpServer | null = null;
  private alertUrl = '';
  private trafficTimer: NodeJS.Timeout | null = null;
  private metricsTimer: NodeJS.Timeout | null = null;
  private restarting = false;
  private processGeneration = 0;

  private incidentSequence = 2040;
  private deployedRegression: { scenarioId: FaultScenarioId; sha: string } | null = null;
  private stagedCandidate: { incidentId: string; scenarioId: FaultScenarioId; candidateVersion: string; sha: string } | null = null;
  private onIncidentAlert?: (alert: IncidentAlertWebhook) => Promise<void> | void;
  private pendingAlertResolvers: Array<(a: IncidentAlertWebhook) => void> = [];
  private alertedVersions = new Set<string>();

  private cachedMetrics = {
    deployedVersion: LAST_KNOWN_GOOD_VERSION,
    pid: 0,
    totalRequests: 0,
    totalErrors: 0,
    errorRatePct: 0,
    p99LatencyMs: 0,
    activeInventoryLocks: 0,
    maxInventoryLocks: 3,
    status: 'healthy' as 'healthy' | 'degraded',
    windowRequests: 0,
  };

  constructor(opts: LiveCheckoutTargetOptions = {}) {
    this.sourceDir = opts.sourceDir ?? path.resolve(process.cwd(), 'services/checkout-api');
    this.explicitWorkDir = opts.workDir ?? null;
    this.workDir = opts.workDir ?? path.resolve(process.cwd(), '.vigil-state', `checkout-api-live-${randomBytes(3).toString('hex')}`);
    this.trafficIntervalMs = opts.trafficIntervalMs ?? 250;
  }
  private readonly explicitWorkDir: string | null;

  // ------------------------------------------------------------------ lifecycle

  public getBaseUrl(): string {
    return `http://127.0.0.1:${this.boundPort}`;
  }

  public getWorkDir(): string {
    return this.workDir;
  }

  /** Continue numbering after incidents a live Switch server already has rooms for (`INC-<n>`). */
  public seedIncidentSequence(lastUsed: number): void {
    if (Number.isFinite(lastUsed) && lastUsed > this.incidentSequence) this.incidentSequence = lastUsed;
  }

  public setIncidentWebhook(cb: (alert: IncidentAlertWebhook) => Promise<void> | void): void {
    this.onIncidentAlert = cb;
  }

  public async start(port = 4020): Promise<number> {
    // A fixed port means a long-lived run: use a stable path so an external coding agent can be
    // pointed at it. Ephemeral ports (tests) keep a random suffix so parallel runs never collide.
    if (!this.explicitWorkDir && port !== 0) {
      this.workDir = path.resolve(process.cwd(), '.vigil-state', `checkout-api-live-${port}`);
    }
    await this.prepareRepo();
    await this.startAlertCollector();
    this.boundPort = port === 0 ? await findFreePort() : port;
    await this.spawnService(this.boundPort);
    this.metricsTimer = setInterval(() => void this.pollMetrics(), 1000);
    if (this.trafficIntervalMs > 0) {
      this.trafficTimer = setInterval(() => void this.tickTraffic(), this.trafficIntervalMs);
    }
    await this.pollMetrics();
    return this.boundPort;
  }

  public async stop(): Promise<void> {
    if (this.trafficTimer) clearInterval(this.trafficTimer);
    if (this.metricsTimer) clearInterval(this.metricsTimer);
    this.trafficTimer = null;
    this.metricsTimer = null;
    await this.killService();
    if (this.alertServer) {
      await new Promise<void>((r) => this.alertServer!.close(() => r()));
      this.alertServer = null;
    }
  }

  private async prepareRepo(): Promise<void> {
    if (!existsSync(this.sourceDir)) throw new Error(`checkout-api source not found at ${this.sourceDir}`);
    rmSync(this.workDir, { recursive: true, force: true });
    mkdirSync(this.workDir, { recursive: true });
    cpSync(this.sourceDir, this.workDir, {
      recursive: true,
      filter: (src) => !src.includes(`${path.sep}node_modules`) && !src.includes(`${path.sep}.git${path.sep}`) && !src.endsWith(`${path.sep}.git`),
    });
    // The working copy borrows this repo's node_modules so `node --import tsx` resolves there.
    const rootModules = path.resolve(process.cwd(), 'node_modules');
    if (existsSync(rootModules)) symlinkSync(rootModules, path.join(this.workDir, 'node_modules'), 'dir');
    writeFileSync(path.join(this.workDir, '.gitignore'), 'node_modules\n');
    writeFileSync(path.join(this.workDir, 'VERSION'), `${LAST_KNOWN_GOOD_VERSION}\n`);

    await this.git(['init', '-q', '-b', 'main']);
    await this.git(['add', '-A']);
    await this.gitCommit(`release: ${LAST_KNOWN_GOOD_VERSION} checkout-api (last known good)`, 'Release Bot <release-bot@team.dev>');
    await this.git(['tag', LAST_KNOWN_GOOD_VERSION]);
  }

  private async startAlertCollector(): Promise<void> {
    this.alertServer = createServer(async (req, res) => {
      if (req.method === 'POST' && req.url === '/alerts') {
        try {
          const body = await readJson(req);
          await this.handleAlertWebhook(body as RawServiceAlert);
          res.writeHead(202, { 'Content-Type': 'application/json' });
          res.end('{"accepted":true}');
        } catch (err) {
          res.writeHead(500);
          res.end(String(err));
        }
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => this.alertServer!.listen(0, '127.0.0.1', () => resolve()));
    const addr = this.alertServer.address();
    if (addr && typeof addr === 'object') this.alertUrl = `http://127.0.0.1:${addr.port}/alerts`;
  }

  private async spawnService(port: number): Promise<void> {
    const expectedVersion = readFileSync(path.join(this.workDir, 'VERSION'), 'utf8').trim();
    this.processGeneration += 1;
    this.child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
      cwd: this.workDir,
      env: {
        ...process.env,
        PORT: String(port),
        CHECKOUT_API_PORT: String(port),
        VIGIL_ALERT_WEBHOOK: this.alertUrl,
        NODE_NO_WARNINGS: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child.stdout?.on('data', () => undefined);
    this.child.stderr?.on('data', (d) => {
      const text = String(d);
      if (/error/i.test(text) && !/ExperimentalWarning/.test(text)) process.stderr.write(`[checkout-api] ${text}`);
    });

    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`);
        if (res.ok) {
          const body = (await res.json()) as { deployedVersion: string };
          if (body.deployedVersion === expectedVersion) return;
        }
      } catch {
        // not up yet
      }
      await sleep(100);
    }
    throw new Error(`checkout-api ${expectedVersion} did not become healthy on :${port}`);
  }

  private async killService(): Promise<void> {
    const child = this.child;
    this.child = null;
    if (!child || child.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        child.kill('SIGKILL');
      }, 2000);
      child.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
      child.kill('SIGTERM');
    });
  }

  /** Real deploy: stop the running process and start the code at HEAD of the working copy. */
  private async restartService(): Promise<void> {
    this.restarting = true;
    try {
      await this.killService();
      await this.spawnService(this.boundPort);
    } finally {
      this.restarting = false;
    }
    await this.pollMetrics();
  }

  // ------------------------------------------------------------------ telemetry (measured)

  private async pollMetrics(): Promise<void> {
    if (this.restarting || !this.child) return;
    const generation = this.processGeneration;
    try {
      const res = await fetch(`${this.getBaseUrl()}/metrics`);
      if (!res.ok) return;
      const m = (await res.json()) as typeof this.cachedMetrics;
      if (generation !== this.processGeneration) return; // a deploy happened mid-flight
      this.cachedMetrics = {
        deployedVersion: m.deployedVersion,
        pid: m.pid,
        totalRequests: m.totalRequests,
        totalErrors: m.totalErrors,
        errorRatePct: m.errorRatePct,
        p99LatencyMs: Math.round(m.p99LatencyMs * 10) / 10,
        activeInventoryLocks: m.activeInventoryLocks,
        maxInventoryLocks: m.maxInventoryLocks,
        status: m.status,
        windowRequests: m.windowRequests,
      };
    } catch {
      // service restarting; keep last sample
    }
  }

  private trafficCursor = 0;
  private async tickTraffic(): Promise<void> {
    if (this.restarting || !this.child) return;
    const payload = SYNTHETIC_TRAFFIC[this.trafficCursor++ % SYNTHETIC_TRAFFIC.length];
    try {
      await fetch(`${this.getBaseUrl()}/api/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, cartId: `${payload.cartId}_${this.trafficCursor}` }),
      });
    } catch {
      // connection refused during restarts is not a service error
    }
  }

  public getTelemetry() {
    return {
      deployedVersion: this.cachedMetrics.deployedVersion,
      lastKnownGoodVersion: LAST_KNOWN_GOOD_VERSION,
      stagedCandidateVersion: this.stagedCandidate?.candidateVersion ?? null,
      stagedCandidateSha: this.stagedCandidate?.sha ?? null,
      pid: this.cachedMetrics.pid,
      totalRequests: this.cachedMetrics.totalRequests,
      totalErrors: this.cachedMetrics.totalErrors,
      errorRatePct: this.cachedMetrics.errorRatePct,
      p99LatencyMs: this.cachedMetrics.p99LatencyMs,
      activeInventoryLocks: this.cachedMetrics.activeInventoryLocks,
      maxInventoryLocks: this.cachedMetrics.maxInventoryLocks,
      windowRequests: this.cachedMetrics.windowRequests,
      status: this.cachedMetrics.status,
      workDir: this.workDir,
    };
  }

  // ------------------------------------------------------------------ git helpers

  private async git(args: string[]): Promise<string> {
    const { stdout } = await execFileAsync('git', args, { cwd: this.workDir, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    return stdout.trim();
  }

  private async gitCommit(message: string, author: string): Promise<string> {
    await this.git([
      '-c', 'user.name=Vigil',
      '-c', 'user.email=vigil@switch.local',
      'commit', '-q', '--allow-empty', '-m', message, `--author=${author}`,
    ]);
    return this.git(['rev-parse', '--short', 'HEAD']);
  }

  public async getRepoLog(limit = 8): Promise<RepoCommit[]> {
    try {
      const out = await this.git(['log', `-${limit}`, '--date=unix', '--pretty=format:%h%x1f%an <%ae>%x1f%s%x1f%ad']);
      if (!out) return [];
      return out.split('\n').map((line) => {
        const [sha, author, message, at] = line.split('\x1f');
        return { sha, author, message, at: Number(at) * 1000 };
      });
    } catch {
      return [];
    }
  }

  private async headSha(): Promise<string> {
    return this.git(['rev-parse', '--short', 'HEAD']);
  }

  /** First changed line of the regression commit inside the service source, for the dossier. */
  private async locateChange(sha: string): Promise<{ filePath: string; line: number }> {
    const diff = await this.git(['show', '--format=', '--unified=0', sha, '--', 'src']).catch(() => '');
    let filePath = 'src/cartPricing.ts';
    let line = 1;
    const fileMatch = diff.match(/^\+\+\+ b\/(.+)$/m);
    if (fileMatch) filePath = fileMatch[1];
    const hunk = diff.match(/^@@ -\d+(?:,\d+)? \+(\d+)/m);
    if (hunk) line = Number(hunk[1]);
    return { filePath: `services/checkout-api/${filePath}`, line };
  }

  // ------------------------------------------------------------------ regression deploy (real)

  /**
   * Deploy a regression for real: apply the release patch to the working copy, commit it with the
   * offending author and message, restart the service from that commit, then replay the production
   * payload against the new process. The service itself raises the alert webhook on its first 5xx.
   */
  public async injectFaultRelease(scenarioId: FaultScenarioId): Promise<IncidentAlertWebhook> {
    const spec = FAULT_CATALOG[scenarioId];
    const patchPath = path.join(this.sourceDir, 'releases', spec.patchFile);
    if (!existsSync(patchPath)) throw new Error(`Missing release patch ${patchPath}`);

    // Always deploy on top of last-known-good so scenarios are independent.
    await this.git(['reset', '-q', '--hard', LAST_KNOWN_GOOD_VERSION]);
    await this.git(['apply', patchPath]);
    await this.git(['add', '-A']);
    const sha = await this.gitCommit(spec.commitMessage, spec.commitAuthor);
    this.deployedRegression = { scenarioId, sha };
    this.stagedCandidate = null;
    this.alertedVersions.delete(REGRESSION_VERSION);

    await this.restartService();

    const alertPromise = new Promise<IncidentAlertWebhook>((resolve) => this.pendingAlertResolvers.push(resolve));

    // Replay the production payload against the freshly deployed process (real HTTP).
    for (let i = 0; i < spec.reproAttempts; i++) {
      await fetch(`${this.getBaseUrl()}/api/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...spec.reproPayload, cartId: `${spec.reproPayload.cartId}_${i}` }),
      }).catch(() => undefined);
    }

    const alert = await Promise.race([alertPromise, sleep(8000).then(() => null)]);
    if (!alert) throw new Error('checkout-api did not raise an alert webhook after the regression deploy');
    await this.pollMetrics(); // the repro errors are in the window now
    return alert;
  }

  /** Receives the service's real alert webhook, enriches it with git context, and notifies Vigil. */
  public async handleAlertWebhook(raw: RawServiceAlert): Promise<IncidentAlertWebhook | null> {
    const version = raw.deployedVersion;
    if (this.alertedVersions.has(version)) return null;
    this.alertedVersions.add(version);

    const sha = await this.headSha();
    const log = await this.getRepoLog(1);
    const where = await this.locateChange(sha);
    const scenarioId: FaultScenarioId =
      this.deployedRegression?.scenarioId ??
      (/minorScale/.test(raw.errorMessage)
        ? 'jpy_zero_decimal_500'
        : /semaphore|Lock/.test(raw.errorMessage)
          ? 'inventory_lock_leak_503'
          : 'promo_negative_ledger_500');

    this.incidentSequence += 1;
    const alert: IncidentAlertWebhook = {
      incidentId: `INC-${this.incidentSequence}`,
      scenarioId,
      service: raw.service ?? 'checkout-api',
      deployedVersion: version,
      lastKnownGoodVersion: LAST_KNOWN_GOOD_VERSION,
      suspectedCommit: {
        sha,
        author: log[0]?.author ?? 'unknown',
        message: log[0]?.message ?? 'unknown',
        filePath: where.filePath,
        line: where.line,
      },
      endpoint: raw.endpoint ?? 'POST /api/checkout',
      httpStatus: raw.httpStatus ?? 500,
      errorRatePct: raw.metrics?.errorRatePct ?? 0,
      p99LatencyMs: Math.round((raw.metrics?.p99LatencyMs ?? 0) * 10) / 10,
      errorMessage: `${raw.errorName ?? 'Error'}: ${raw.errorMessage}`,
      stackTrace: raw.stackTrace ?? '',
      reproductionPayload: (raw.reproductionPayload as CheckoutRequest) ?? FAULT_CATALOG[scenarioId].reproPayload,
      detectedAt: raw.detectedAt ?? Date.now(),
    };

    await this.pollMetrics();
    for (const r of this.pendingAlertResolvers.splice(0)) r(alert);
    if (this.onIncidentAlert) await this.onIncidentAlert(alert);
    return alert;
  }

  // ------------------------------------------------------------------ reproduction + verification (real)

  private async reproduceAgainstLive(scenarioId: FaultScenarioId): Promise<{ confirmed: boolean; output: string }> {
    const spec = FAULT_CATALOG[scenarioId];
    let last: { status: number; body: { error?: string; message?: string } } | null = null;
    for (let i = 0; i < spec.reproAttempts; i++) {
      try {
        const res = await fetch(`${this.getBaseUrl()}/api/checkout`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...spec.reproPayload, cartId: `${spec.reproPayload.cartId}_repro_${i}` }),
        });
        last = { status: res.status, body: (await res.json().catch(() => ({}))) as { error?: string; message?: string } };
      } catch (err) {
        last = { status: 0, body: { error: 'NetworkError', message: String(err) } };
      }
    }
    if (!last) return { confirmed: false, output: 'no response' };
    const confirmed = last.status >= 500;
    return {
      confirmed,
      output: `HTTP ${last.status} ${last.body.error ?? ''}${last.body.message ? `: ${last.body.message}` : ''}`.trim(),
    };
  }

  /** Run the service's real test suite in the working copy (node:test, TAP reporter). */
  private async runServiceTests(): Promise<{ matrix: PatchVerificationResult['testMatrix']; raw: string; green: boolean }> {
    const { stdout, stderr, code } = await new Promise<{ stdout: string; stderr: string; code: number }>((resolve) => {
      const p = spawn(process.execPath, ['--import', 'tsx', '--test', '--test-reporter=tap', 'test/cartPricing.test.ts'], {
        cwd: this.workDir,
        env: { ...process.env, NODE_NO_WARNINGS: '1' },
      });
      let out = '';
      let err = '';
      p.stdout.on('data', (d) => (out += String(d)));
      p.stderr.on('data', (d) => (err += String(d)));
      p.on('close', (c) => resolve({ stdout: out, stderr: err, code: c ?? 1 }));
    });

    const matrix: PatchVerificationResult['testMatrix'] = [];
    const lines = stdout.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^(not ok|ok) \d+ - (.+?)(?: # .*)?$/);
      if (!m) continue;
      const passed = m[1] === 'ok';
      let detail = passed ? 'passed' : 'failed';
      if (!passed) {
        for (let j = i + 1; j < Math.min(lines.length, i + 30); j++) {
          const em = lines[j].match(/^\s+(?:error|failureType|message):\s*['"]?(.+?)['"]?\s*$/);
          if (em && /error|message/.test(lines[j])) {
            detail = em[1].replace(/\\n/g, ' ').slice(0, 160);
            break;
          }
        }
      }
      matrix.push({ name: m[2].trim(), passed, detail });
    }
    if (matrix.length === 0) {
      matrix.push({ name: 'service test suite executed', passed: false, detail: (stderr || stdout).slice(0, 200) || `exit code ${code}` });
    }
    return { matrix, raw: (stdout + stderr).slice(-4000), green: code === 0 && matrix.every((t) => t.passed) };
  }

  /** Boot the candidate commit on an ephemeral staging port and replay the production repro payload. */
  private async stagingProbe(scenarioId: FaultScenarioId): Promise<{ passed: boolean; detail: string }> {
    const spec = FAULT_CATALOG[scenarioId];
    const port = 20000 + Math.floor(Math.random() * 20000);
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
      cwd: this.workDir,
      env: { ...process.env, PORT: String(port), VIGIL_ALERT_WEBHOOK: '', NODE_NO_WARNINGS: '1' },
      stdio: 'ignore',
    });
    try {
      const deadline = Date.now() + 10_000;
      let up = false;
      while (Date.now() < deadline && !up) {
        try {
          up = (await fetch(`http://127.0.0.1:${port}/health`)).ok;
        } catch {
          await sleep(80);
        }
      }
      if (!up) return { passed: false, detail: 'candidate failed to boot on staging port' };
      let last = 0;
      let body: { chargeMinorUnits?: number; error?: string; message?: string } = {};
      for (let i = 0; i < spec.reproAttempts; i++) {
        const res = await fetch(`http://127.0.0.1:${port}/api/checkout`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...spec.reproPayload, cartId: `${spec.reproPayload.cartId}_stage_${i}` }),
        });
        last = res.status;
        body = (await res.json().catch(() => ({}))) as typeof body;
      }
      const passed = last < 500;
      return {
        passed,
        detail: passed
          ? `staging :${port} replayed production payload -> HTTP ${last}${body.chargeMinorUnits !== undefined ? ` charge=${body.chargeMinorUnits}` : ''}`
          : `staging :${port} still fails -> HTTP ${last} ${body.error ?? ''}: ${body.message ?? ''}`.trim(),
      };
    } finally {
      child.kill('SIGKILL');
    }
  }

  private async describeCandidate(baseRef: string): Promise<{ diff: string; changedLines: number; touchedFiles: string[]; sha: string }> {
    const sha = await this.headSha();
    const diff = await this.git(['diff', '--no-color', baseRef, 'HEAD', '--', 'src', 'test']);
    const numstat = await this.git(['diff', '--numstat', baseRef, 'HEAD', '--', 'src', 'test']);
    let changedLines = 0;
    const touchedFiles: string[] = [];
    for (const line of numstat.split('\n').filter(Boolean)) {
      const [add, del, file] = line.split('\t');
      changedLines += (Number(add) || 0) + (Number(del) || 0);
      touchedFiles.push(`services/checkout-api/${file}`);
    }
    return { diff, changedLines, touchedFiles, sha };
  }

  private async finishVerification(
    incidentId: string,
    scenarioId: FaultScenarioId,
    repro: { confirmed: boolean; output: string },
    baseRef: string,
    author: string,
    source: PatchVerificationResult['source'],
    preMatrix: PatchVerificationResult['testMatrix'] = [],
  ): Promise<PatchVerificationResult> {
    const tests = await this.runServiceTests();
    const probe = tests.green ? await this.stagingProbe(scenarioId) : { passed: false, detail: 'skipped: test suite red' };
    const matrix = [
      ...preMatrix,
      { name: `Fault ${scenarioId} no longer reproduces on candidate (staging probe)`, ...probe },
      ...tests.matrix,
    ];
    const allPassed = repro.confirmed && matrix.every((t) => t.passed);
    const described = await this.describeCandidate(baseRef);

    if (allPassed) {
      this.stagedCandidate = { incidentId, scenarioId, candidateVersion: HOTFIX_VERSION, sha: described.sha };
    } else {
      // Red candidate: discard the commit, production stays exactly where it was.
      await this.git(['reset', '-q', '--hard', baseRef]);
      this.stagedCandidate = null;
    }

    return {
      scenarioId,
      reproConfirmed: repro.confirmed,
      reproErrorOutput: repro.output,
      candidateVersion: HOTFIX_VERSION,
      candidateSha: allPassed ? described.sha : null,
      diffUnified: described.diff || '(patch did not apply)',
      changedLines: described.changedLines,
      touchedFiles: described.touchedFiles,
      testMatrix: matrix,
      allPassed,
      testRunOutput: tests.raw,
      author,
      source,
    };
  }

  /**
   * Auto mode: Vigil's own patcher reverts the regression commit for real (`git revert`), bumps
   * VERSION, runs the real test suite, boots the candidate on a staging port and replays the
   * production payload. Only a fully green candidate is staged.
   */
  public async reproduceAndStagePatch(incidentId: string, scenarioId: FaultScenarioId): Promise<PatchVerificationResult> {
    const repro = await this.reproduceAgainstLive(scenarioId);
    const baseRef = await this.headSha();
    const regressionSha = this.deployedRegression?.sha ?? baseRef;

    await this.git(['-c', 'user.name=Vigil Patcher', '-c', 'user.email=vigil-patcher@switch.local', 'revert', '--no-edit', regressionSha]);
    writeFileSync(path.join(this.workDir, 'VERSION'), `${HOTFIX_VERSION}\n`);
    await this.git(['add', '-A']);
    await this.git([
      '-c', 'user.name=Vigil Patcher', '-c', 'user.email=vigil-patcher@switch.local',
      'commit', '-q', '--amend', '--no-edit', '-m',
      `hotfix(${incidentId}): revert ${regressionSha} "${FAULT_CATALOG[scenarioId].commitMessage}" -> ${HOTFIX_VERSION}`,
    ]);

    return this.finishVerification(incidentId, scenarioId, repro, baseRef, 'vigil-patcher', 'vigil-patcher');
  }

  /**
   * External mode: a coding agent's unified diff is applied with `git apply` to the regressed
   * working copy, committed under its name, and verified exactly like the auto path.
   */
  public async stageExternalPatch(
    incidentId: string,
    scenarioId: FaultScenarioId,
    submission: { diffUnified: string; author: string; touchedFiles?: string[] },
  ): Promise<PatchVerificationResult> {
    const repro = await this.reproduceAgainstLive(scenarioId);
    const baseRef = await this.headSha();
    let diff = submission.diffUnified.replace(/\r\n/g, '\n').trim();

    // A coding agent may have edited the working copy directly (Switch Console binds it to the
    // service directory). If so, its uncommitted edits ARE the candidate.
    const dirty = (await this.git(['status', '--porcelain', '--', 'src', 'test'])).trim();
    let applied = true;
    let applyDetail = 'git apply succeeded';
    if (!diff && dirty) {
      diff = await this.git(['diff', '--no-color', '--', 'src', 'test']);
      applyDetail = `picked up uncommitted working-copy edits (${dirty.split('\n').length} file(s))`;
    } else if (!diff) {
      applied = false;
      applyDetail = 'no diff submitted and the working copy has no uncommitted edits';
    } else {
      if (dirty) await this.git(['checkout', '-q', '--', 'src', 'test']); // apply the submitted diff on a clean tree
      const patchPath = path.join(this.workDir, '.vigil-candidate.patch');
      writeFileSync(patchPath, diff + '\n');
      try {
        await this.git(['apply', '--check', '--whitespace=nowarn', patchPath]);
        await this.git(['apply', '--whitespace=nowarn', patchPath]);
      } catch (err) {
        applied = false;
        applyDetail = String((err as Error & { stderr?: string }).stderr ?? (err as Error).message).trim().slice(0, 200);
      }
      rmSync(patchPath, { force: true });
    }

    if (!applied) {
      await this.git(['reset', '-q', '--hard', baseRef]);
      this.stagedCandidate = null;
      return {
        scenarioId,
        reproConfirmed: repro.confirmed,
        reproErrorOutput: repro.output,
        candidateVersion: HOTFIX_VERSION,
        candidateSha: null,
        diffUnified: diff || '(empty)',
        changedLines: 0,
        touchedFiles: submission.touchedFiles ?? [],
        testMatrix: [{ name: 'patch applies cleanly to the regressed working copy (git apply --check)', passed: false, detail: applyDetail }],
        allPassed: false,
        testRunOutput: applyDetail,
        author: submission.author,
        source: 'external-coder',
      };
    }

    writeFileSync(path.join(this.workDir, 'VERSION'), `${HOTFIX_VERSION}\n`);
    await this.git(['add', '-A']);
    const safeAuthor = submission.author.replace(/[<>]/g, '').trim() || 'external-coder';
    await this.gitCommit(
      `hotfix(${incidentId}): candidate from ${safeAuthor} -> ${HOTFIX_VERSION}`,
      `${safeAuthor} <${safeAuthor.toLowerCase().replace(/[^a-z0-9]+/g, '-')}@switch.local>`,
    );

    return this.finishVerification(incidentId, scenarioId, repro, baseRef, submission.author, 'external-coder', [
      { name: 'patch applies cleanly to the regressed working copy (git apply --check)', passed: true, detail: applyDetail },
    ]);
  }

  /** The reverse of the deployed regression (source files only): the known-good forward fix. */
  public async getReferenceFixDiff(): Promise<string> {
    const sha = this.deployedRegression?.sha;
    if (!sha) return '';
    return this.git(['diff', '--no-color', sha, `${sha}~1`, '--', 'src']);
  }

  // ------------------------------------------------------------------ release (real)

  public async applyApprovedRelease(mode: 'promote' | 'rollback'): Promise<{ deployedVersion: string; canaryReport: CanaryProbeReport; sha: string }> {
    if (mode === 'promote') {
      if (!this.stagedCandidate) throw new Error('No verified candidate staged');
      // HEAD already points at the verified candidate commit; deploying = restarting from it.
      await this.git(['tag', '-f', HOTFIX_VERSION, this.stagedCandidate.sha]);
    } else {
      await this.git(['reset', '-q', '--hard', LAST_KNOWN_GOOD_VERSION]);
    }
    await this.restartService();
    const sha = await this.headSha();
    const canaryReport = await this.runSyntheticCanaryProbes();
    if (canaryReport.healthy) {
      this.stagedCandidate = null;
      this.deployedRegression = null;
    }
    return { deployedVersion: this.cachedMetrics.deployedVersion, canaryReport, sha };
  }

  public async runSyntheticCanaryProbes(): Promise<CanaryProbeReport> {
    const probes: CheckoutRequest[] = [
      { cartId: 'canary_usd', currency: 'USD', items: [{ sku: 'PRO', qty: 1, unitPriceMajor: 99 }] },
      { cartId: 'canary_eur', currency: 'EUR', items: [{ sku: 'PRO', qty: 1, unitPriceMajor: 89 }] },
      { cartId: 'canary_jpy', currency: 'JPY', items: [{ sku: 'PRO', qty: 2, unitPriceMajor: 4800 }] },
      { cartId: 'canary_krw', currency: 'KRW', items: [{ sku: 'PRO', qty: 1, unitPriceMajor: 55000 }] },
      { cartId: 'canary_promo', currency: 'USD', items: [{ sku: 'STARTER', qty: 1, unitPriceMajor: 29 }], promoCodes: ['VIP40', 'SAVE15', 'VIP40'] },
    ];
    let passed = 0;
    let maxLatencyMs = 0;
    const details: string[] = [];
    for (const payload of probes) {
      const t0 = Date.now();
      try {
        const res = await fetch(`${this.getBaseUrl()}/api/checkout`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const elapsed = Math.max(1, Date.now() - t0);
        maxLatencyMs = Math.max(maxLatencyMs, elapsed);
        if (res.ok) {
          passed += 1;
          const body = (await res.json()) as { chargeMinorUnits: number };
          details.push(`${payload.cartId} (${payload.currency}): 200 OK [${body.chargeMinorUnits} minor, ${elapsed}ms]`);
        } else {
          details.push(`${payload.cartId} (${payload.currency}): FAILED HTTP ${res.status}`);
        }
      } catch (err) {
        details.push(`${payload.cartId} (${payload.currency}): FAILED ${String(err)}`);
      }
    }
    await this.pollMetrics();
    return { probesRun: probes.length, probesPassed: passed, maxLatencyMs, healthy: passed === probes.length, details };
  }
}

/** Backwards-compatible name used across the runtime. */
export { LiveCheckoutTarget as CheckoutMicroservice };

export interface RawServiceAlert {
  service?: string;
  deployedVersion: string;
  endpoint?: string;
  httpStatus?: number;
  errorName?: string;
  errorMessage: string;
  stackTrace?: string;
  reproductionPayload?: unknown;
  metrics?: { errorRatePct?: number; p99LatencyMs?: number };
  detectedAt?: number;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return raw ? JSON.parse(raw) : {};
}

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const addr = probe.address();
      const port = addr && typeof addr === 'object' ? addr.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
