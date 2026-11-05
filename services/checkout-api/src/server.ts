/**
 * checkout-api — HTTP service
 *
 * Runs as its own process from a git-backed working copy. Vigil deploys regressions and hotfixes
 * by committing to that working copy and restarting this process.
 *
 * Endpoints:
 *   GET  /health         deployed version, status, live metrics summary
 *   GET  /metrics        rolling-window request metrics (real, measured)
 *   POST /api/checkout   price and authorize a cart
 *
 * Alerting: on the first 5xx produced by the running version, POST a real webhook to
 * `VIGIL_ALERT_WEBHOOK` with the error, the stack trace, the offending payload and the metrics.
 */
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { authorizeCheckout, CheckoutError, CheckoutRequest, InventoryPool } from './cartPricing.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const VERSION = readFileSync(path.resolve(here, '..', 'VERSION'), 'utf8').trim();
const PORT = Number(process.env.PORT || process.env.CHECKOUT_API_PORT || 4020);
const ALERT_WEBHOOK = (process.env.VIGIL_ALERT_WEBHOOK || '').trim();
const WINDOW_MS = 60_000;

const inventoryPool = new InventoryPool(Number(process.env.INVENTORY_SLOTS || 3));

interface Sample {
  at: number;
  status: number;
  latencyMs: number;
}
const samples: Sample[] = [];
let totalRequests = 0;
let totalErrors = 0;
let alertSentForVersion = false;

function record(status: number, latencyMs: number): void {
  const now = Date.now();
  samples.push({ at: now, status, latencyMs });
  totalRequests += 1;
  if (status >= 500) totalErrors += 1;
  while (samples.length && samples[0].at < now - WINDOW_MS) samples.shift();
}

function metrics() {
  const now = Date.now();
  const window = samples.filter((s) => s.at >= now - WINDOW_MS);
  const errors = window.filter((s) => s.status >= 500).length;
  const latencies = window.map((s) => s.latencyMs).sort((a, b) => a - b);
  const p99 = latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.99))] : 0;
  const errorRatePct = window.length ? Math.round((errors / window.length) * 1000) / 10 : 0;
  return {
    service: 'checkout-api',
    deployedVersion: VERSION,
    pid: process.pid,
    windowMs: WINDOW_MS,
    windowRequests: window.length,
    windowErrors: errors,
    errorRatePct,
    p99LatencyMs: p99,
    totalRequests,
    totalErrors,
    activeInventoryLocks: inventoryPool.activeLocks,
    maxInventoryLocks: inventoryPool.maxSlots,
    status: errorRatePct > 2 ? 'degraded' : 'healthy',
  };
}

async function sendAlert(err: Error & { statusCode?: number }, payload: unknown): Promise<void> {
  if (!ALERT_WEBHOOK || alertSentForVersion) return;
  alertSentForVersion = true;
  const body = {
    service: 'checkout-api',
    deployedVersion: VERSION,
    endpoint: 'POST /api/checkout',
    httpStatus: err.statusCode ?? 500,
    errorName: err.name,
    errorMessage: err.message,
    stackTrace: err.stack ?? `${err.name}: ${err.message}`,
    reproductionPayload: payload,
    metrics: metrics(),
    detectedAt: Date.now(),
  };
  try {
    await fetch(ALERT_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    alertSentForVersion = false; // let the next failure retry
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return raw ? JSON.parse(raw) : {};
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (req.method === 'GET' && url.pathname === '/health') {
    const m = metrics();
    sendJson(res, 200, {
      service: m.service,
      deployedVersion: m.deployedVersion,
      status: m.status,
      pid: m.pid,
      errorRatePct: m.errorRatePct,
      p99LatencyMs: m.p99LatencyMs,
      activeInventoryLocks: m.activeInventoryLocks,
      maxInventoryLocks: m.maxInventoryLocks,
      totalRequests: m.totalRequests,
      totalErrors: m.totalErrors,
    });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/metrics') {
    sendJson(res, 200, metrics());
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/checkout') {
    const t0 = process.hrtime.bigint();
    let payload: CheckoutRequest | null = null;
    try {
      payload = (await readJson(req)) as CheckoutRequest;
      const result = authorizeCheckout(payload, inventoryPool);
      const latencyMs = Number(process.hrtime.bigint() - t0) / 1e6;
      record(200, latencyMs);
      sendJson(res, 200, { ...result, deployedVersion: VERSION, latencyMs: Math.round(latencyMs * 100) / 100 });
    } catch (e) {
      const err = e as Error & { statusCode?: number };
      const status = err instanceof CheckoutError ? err.statusCode : 500;
      const latencyMs = Number(process.hrtime.bigint() - t0) / 1e6;
      record(status, latencyMs);
      if (status >= 500) void sendAlert(err, payload);
      sendJson(res, status, {
        error: err.name,
        message: err.message,
        stack: err.stack,
        deployedVersion: VERSION,
        cartId: payload?.cartId ?? null,
      });
    }
    return;
  }
  sendJson(res, 404, { error: 'Not found' });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[checkout-api ${VERSION}] listening on http://127.0.0.1:${PORT} (pid ${process.pid})`);
});

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref();
  });
}
