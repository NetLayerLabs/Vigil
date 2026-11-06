import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { normalizeAlert } from '../src/services/alertAdapters.js';

// A monitoring tool is the only trigger in this file: the service raises no alert of its own.
process.env.VIGIL_SELF_ALERTS = 'off';
process.env.VIGIL_OPERATOR_KEY = 'operator-test-key';
process.env.VIGIL_ALERT_TOKEN = 'alert-test-token';
process.env.VIGIL_SENTRY_CLIENT_SECRET = 'sentry-test-secret';

/** Shaped like Prometheus Alertmanager's version 4 webhook. */
const alertmanagerFiring = {
  version: '4',
  status: 'firing',
  receiver: 'vigil',
  commonLabels: { alertname: 'CheckoutHigh5xx', service: 'checkout-api', severity: 'page' },
  commonAnnotations: { summary: 'POST /api/checkout 5xx above 1.5% for 1m', error_rate_pct: '33.3' },
  alerts: [
    {
      status: 'firing',
      labels: { alertname: 'CheckoutHigh5xx', service: 'checkout-api', endpoint: 'POST /api/checkout', status: '500' },
      annotations: { description: 'TypeError: Cannot read properties of undefined (reading \'minorScale\')' },
      startsAt: '2026-11-06T17:00:00Z',
      generatorURL: 'http://prometheus:9090/graph?g0.expr=checkout_5xx_ratio',
    },
  ],
};

/** Shaped like Sentry's issue-alert webhook (integration form, event under `data`). */
const sentryIssue = {
  action: 'triggered',
  data: {
    event: {
      title: "TypeError: Cannot read properties of undefined (reading 'minorScale')",
      release: undefined as string | undefined,
      timestamp: 1793990000,
      request: { method: 'POST', url: 'http://checkout.internal/api/checkout' },
      tags: [
        ['service', 'checkout-api'],
        ['http.status_code', '500'],
      ],
      exception: {
        values: [
          {
            type: 'TypeError',
            value: "Cannot read properties of undefined (reading 'minorScale')",
            stacktrace: {
              frames: [
                { function: 'Server.<anonymous>', filename: 'src/server.ts', lineno: 136, colno: 22 },
                { function: 'authorizeCheckout', filename: 'src/cartPricing.ts', lineno: 141, colno: 42 },
                { function: 'applyPromotions', filename: 'src/cartPricing.ts', lineno: 81, colno: 55 },
              ],
            },
          },
        ],
      },
    },
  },
};

describe('alert webhooks from monitoring tools', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (cleanup) await cleanup();
    cleanup = null;
  });

  it('translates Alertmanager, Sentry and generic payloads into Vigil alerts', () => {
    const am = normalizeAlert('alertmanager', alertmanagerFiring, 'v2.14.0')!;
    expect(am.service).toBe('checkout-api');
    expect(am.deployedVersion).toBe('v2.14.0');
    expect(am.endpoint).toBe('POST /api/checkout');
    expect(am.httpStatus).toBe(500);
    expect(am.errorMessage).toContain('CheckoutHigh5xx');
    expect(am.metrics?.errorRatePct).toBe(33.3);
    expect(normalizeAlert('alertmanager', { ...alertmanagerFiring, status: 'resolved', alerts: [{ ...alertmanagerFiring.alerts[0], status: 'resolved' }] }, 'v2.14.0')).toBeNull();

    const se = normalizeAlert('sentry', sentryIssue, 'v2.14.0')!;
    expect(se.errorMessage).toBe("TypeError: Cannot read properties of undefined (reading 'minorScale')");
    expect(se.endpoint).toBe('POST /api/checkout');
    expect(se.httpStatus).toBe(500);
    // newest frame first, as a stack trace reads
    expect(se.stackTrace?.split('\n')[1]).toContain('applyPromotions (src/cartPricing.ts:81:55)');

    expect(normalizeAlert('generic', { service: 'checkout-api', errorMessage: 'boom', httpStatus: 503 }, 'v9')?.deployedVersion).toBe('v9');
    expect(normalizeAlert('generic', { hello: 'ping' }, 'v9')).toBeNull();
  });

  it('opens an incident only from an authenticated alert, and only when a traceable release is live', async () => {
    const { startVigilRuntime } = await import('../src/index.js');
    const runtime = await startVigilRuntime({ vigilPort: 0, checkoutPort: 0, trafficIntervalMs: 0 });
    cleanup = runtime.stop;
    const viaProxy = { 'X-Forwarded-For': '203.0.113.9', 'Content-Type': 'application/json' };
    const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
      fetch(`${runtime.vigilUrl}${path}`, { method: 'POST', headers: { ...viaProxy, ...headers }, body: JSON.stringify(body) });

    // No token from outside: refused.
    expect((await post('/api/webhooks/alertmanager', alertmanagerFiring)).status).toBe(401);
    // Token, but v2.13.2 (known good) is live: acknowledged, no incident.
    const healthy = await post('/api/webhooks/alertmanager?token=alert-test-token', alertmanagerFiring);
    expect(healthy.status).toBe(200);
    expect(((await healthy.json()) as { reason: string }).reason).toMatch(/No traceable release/);

    // Ship the regression. With self-alerts off the service stays silent, so nothing opens.
    const inject = await fetch(`${runtime.vigilUrl}/api/chaos/inject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer operator-test-key' },
      body: JSON.stringify({ scenarioId: 'jpy_zero_decimal_500' }),
    });
    const injected = (await inject.json()) as { alert?: unknown };
    expect(inject.status).toBe(200);
    expect(injected.alert).toBeNull();
    expect(runtime.coordinator.getActiveIncident()).toBeNull();

    // A wrong Sentry signature is refused; the right one opens the incident.
    const raw = JSON.stringify(sentryIssue);
    const sign = (secret: string) => createHmac('sha256', secret).update(raw, 'utf8').digest('hex');
    const bad = await fetch(`${runtime.vigilUrl}/api/webhooks/sentry`, { method: 'POST', headers: { ...viaProxy, 'Sentry-Hook-Signature': sign('wrong') }, body: raw });
    expect(bad.status).toBe(401);
    const good = await fetch(`${runtime.vigilUrl}/api/webhooks/sentry`, { method: 'POST', headers: { ...viaProxy, 'Sentry-Hook-Signature': sign('sentry-test-secret') }, body: raw });
    expect(good.status).toBe(202);
    expect(((await good.json()) as { incidentId: string }).incidentId).toBe('INC-2041');

    const start = Date.now();
    while (runtime.coordinator.getActiveIncident()?.stage !== 'awaiting_human_gate' && Date.now() - start < 60_000) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const incident = runtime.coordinator.getActiveIncident()!;
    expect(incident.stage).toBe('awaiting_human_gate');
    expect(incident.alert.errorMessage).toContain('minorScale');
    expect(incident.patchVerification?.allPassed).toBe(true);

    // The same release does not open a second incident.
    const again = await post('/api/webhooks/generic?token=alert-test-token', { service: 'checkout-api', errorMessage: 'still failing' });
    expect(((await again.json()) as { accepted: boolean }).accepted).toBe(false);
  });
});
