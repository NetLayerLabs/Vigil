import type { RawServiceAlert } from './checkoutTarget.js';

/**
 * Alerts from real monitoring tools, translated into the alert Vigil's sentinel triages.
 *
 * - `alertmanager`: Prometheus Alertmanager's webhook (version 4). Firing alerts only.
 * - `sentry`: Sentry's issue-alert webhook, legacy plugin or integration shape (`data.event`).
 * - `generic`: plain JSON from anything else (Grafana, Datadog, a script):
 *   `{ service, errorMessage, stackTrace?, endpoint?, httpStatus?, deployedVersion?, metrics? }`.
 *
 * Returns null when the payload is not something to act on (a resolved alert, a test ping).
 * `deployedVersion` falls back to what is running now, so an alert from a tool that does not
 * know Vigil's release names still lands on the current release.
 */
export type AlertProvider = 'alertmanager' | 'sentry' | 'generic';

export const ALERT_PROVIDERS: readonly AlertProvider[] = ['alertmanager', 'sentry', 'generic'];

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {});
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v : undefined);
const num = (v: unknown): number | undefined => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
};

export function normalizeAlert(
  provider: AlertProvider,
  body: unknown,
  currentVersion: string,
): RawServiceAlert | null {
  switch (provider) {
    case 'alertmanager':
      return fromAlertmanager(obj(body), currentVersion);
    case 'sentry':
      return fromSentry(obj(body), currentVersion);
    case 'generic':
      return fromGeneric(obj(body), currentVersion);
  }
}

function fromAlertmanager(body: Json, currentVersion: string): RawServiceAlert | null {
  const alerts = Array.isArray(body.alerts) ? body.alerts.map(obj) : [];
  const firing = alerts.find((a) => a.status === 'firing') ?? (body.status === 'firing' ? alerts[0] : undefined);
  if (!firing) return null;
  const labels = { ...obj(body.commonLabels), ...obj(firing.labels) };
  const notes = { ...obj(body.commonAnnotations), ...obj(firing.annotations) };
  const name = str(labels.alertname) ?? 'Alert';
  const summary = str(notes.summary) ?? str(notes.description) ?? name;
  return {
    service: str(labels.service) ?? str(labels.job) ?? str(labels.app),
    deployedVersion: str(labels.version) ?? str(labels.release) ?? currentVersion,
    endpoint: str(labels.endpoint) ?? str(labels.route) ?? str(labels.handler),
    httpStatus: num(labels.status) ?? num(labels.code),
    errorName: name,
    errorMessage: `${name}: ${summary}`,
    stackTrace: [str(notes.description), str(firing.generatorURL)].filter(Boolean).join('\n') || undefined,
    metrics: { errorRatePct: num(notes.error_rate_pct) ?? num(labels.error_rate_pct), p99LatencyMs: num(notes.p99_ms) },
    detectedAt: Date.parse(str(firing.startsAt) ?? '') || Date.now(),
  };
}

function fromSentry(body: Json, currentVersion: string): RawServiceAlert | null {
  // Integration webhooks wrap the event in `data`; the legacy plugin sends it at the top level.
  const data = obj(body.data);
  const event = obj(data.event ?? body.event);
  if (Object.keys(event).length === 0 && !str(body.message) && !str(body.culprit)) return null;
  const exception = obj((Array.isArray(obj(event.exception).values) ? (obj(event.exception).values as unknown[]) : []).at(-1));
  const type = str(exception.type);
  const value = str(exception.value);
  const message = type ? `${type}: ${value ?? ''}`.trim() : (str(event.title) ?? str(body.message) ?? str(body.culprit) ?? 'Sentry issue');
  const frames = (Array.isArray(obj(exception.stacktrace).frames) ? (obj(exception.stacktrace).frames as unknown[]) : []).map(obj);
  // Sentry lists frames oldest first; a stack trace reads newest first.
  const stack = frames
    .slice()
    .reverse()
    .map((f) => `    at ${str(f.function) ?? '<anonymous>'} (${str(f.abs_path) ?? str(f.filename) ?? '?'}:${num(f.lineno) ?? 0}:${num(f.colno) ?? 0})`)
    .join('\n');
  const tags = new Map<string, string>(
    (Array.isArray(event.tags) ? event.tags : []).flatMap((t): Array<[string, string]> => {
      if (Array.isArray(t) && typeof t[0] === 'string' && typeof t[1] === 'string') return [[t[0], t[1]]];
      const o = obj(t);
      return str(o.key) && str(o.value) ? [[o.key as string, o.value as string]] : [];
    }),
  );
  const request = obj(event.request);
  return {
    service: tags.get('service') ?? str(body.project_name) ?? str(body.project) ?? str(event.project),
    deployedVersion: str(event.release) ?? tags.get('release') ?? currentVersion,
    endpoint: request.method && request.url ? `${String(request.method)} ${new URL(String(request.url), 'http://x').pathname}` : tags.get('transaction'),
    httpStatus: num(tags.get('http.status_code')),
    errorName: type,
    errorMessage: message,
    stackTrace: stack ? `${message}\n${stack}` : message,
    detectedAt: (num(event.timestamp) ?? Date.now() / 1000) * 1000,
  };
}

function fromGeneric(body: Json, currentVersion: string): RawServiceAlert | null {
  const errorMessage = str(body.errorMessage) ?? str(body.message) ?? str(body.title);
  if (!errorMessage) return null;
  const metrics = obj(body.metrics);
  return {
    service: str(body.service),
    deployedVersion: str(body.deployedVersion) ?? str(body.version) ?? currentVersion,
    endpoint: str(body.endpoint),
    httpStatus: num(body.httpStatus) ?? num(body.status),
    errorName: str(body.errorName),
    errorMessage,
    stackTrace: str(body.stackTrace) ?? str(body.stack),
    reproductionPayload: body.reproductionPayload,
    metrics: { errorRatePct: num(metrics.errorRatePct), p99LatencyMs: num(metrics.p99LatencyMs) },
    detectedAt: num(body.detectedAt) ?? Date.now(),
  };
}
