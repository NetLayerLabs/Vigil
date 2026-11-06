import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * The service Vigil guards, described as data. Vigil keeps a git-backed working copy of it, starts it,
 * sends it traffic and canary probes, runs its tests, and reverts, patches, promotes or rolls it back.
 *
 * Default: `targets/checkout-api.target.json`, the demo checkout service. Point VIGIL_TARGET at another
 * manifest to guard a different repository. See `targets/README.md` for every field.
 */
export interface TargetManifest {
  name: string;
  description?: string;
  /** A folder in this repository, copied into a fresh git working copy, or a git repository to clone. */
  source: { path: string } | { git: string; ref?: string };
  /** `lastKnownGood`: the git tag rollback resets to. `hotfix`: the tag a promoted fix gets. */
  versions: { lastKnownGood: string; hotfix: string };
  /** Folders that hold the code: diffs, changed-line counts and the suspect file come from these. */
  codePaths: string[];
  /** Run once in the working copy after it is created (for a cloned repository, e.g. `npm ci`). */
  install?: string[];
  /** Start the service. `node` means the Node.js that runs Vigil. */
  start: string[];
  /** Run the test suite. TAP output gives one row per test; otherwise the exit code decides. */
  test: string[];
  /** Environment variables that receive the port the service must listen on. */
  portEnv: string[];
  /** Answers 200 when the service is up. If its JSON has `deployedVersion`, that must match the release. */
  healthPath: string;
  /** Optional: JSON with deployedVersion, pid, totalRequests, totalErrors, errorRatePct, p99LatencyMs. */
  metricsPath?: string;
  /** The request that traffic, reproduction, the staging replay and the canaries send. */
  endpoint: { method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; path: string };
  /** Bodies for steady background traffic (sent in turn). Empty: no traffic. */
  traffic: unknown[];
  /** Post-release probes; every one must answer 2xx before an incident closes. */
  canaries: Array<{ name: string; body?: unknown }>;
  /** `builtin-checkout`: the three seeded regressions (demo only). `none`: chaos releases are off. */
  faults: 'builtin-checkout' | 'none';
}

function fail(file: string, message: string): never {
  throw new Error(`Target manifest ${file}: ${message}`);
}

const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string' && x !== '');

export function loadTargetManifest(file = process.env.VIGIL_TARGET?.trim() || 'targets/checkout-api.target.json'): TargetManifest & { file: string } {
  const resolved = path.resolve(process.cwd(), file);
  let m: Record<string, unknown>;
  try {
    m = JSON.parse(readFileSync(resolved, 'utf8')) as Record<string, unknown>;
  } catch (err) {
    fail(file, `cannot be read as JSON (${(err as Error).message})`);
  }
  if (typeof m.name !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/.test(m.name)) fail(file, '`name` must be a lowercase identifier');
  const source = m.source as Record<string, unknown> | undefined;
  if (!source || (typeof source.path !== 'string' && typeof source.git !== 'string')) fail(file, '`source` needs `path` or `git`');
  const versions = m.versions as Record<string, unknown> | undefined;
  if (!versions || typeof versions.lastKnownGood !== 'string' || typeof versions.hotfix !== 'string') {
    fail(file, '`versions` needs `lastKnownGood` and `hotfix`');
  }
  for (const key of ['codePaths', 'start', 'test', 'portEnv'] as const) {
    if (!isStrings(m[key])) fail(file, `\`${key}\` must be a non-empty list of strings`);
  }
  if (m.install !== undefined && !isStrings(m.install)) fail(file, '`install` must be a list of strings');
  if (typeof m.healthPath !== 'string' || !m.healthPath.startsWith('/')) fail(file, '`healthPath` must start with /');
  if (m.metricsPath !== undefined && (typeof m.metricsPath !== 'string' || !m.metricsPath.startsWith('/'))) {
    fail(file, '`metricsPath` must start with /');
  }
  const endpoint = m.endpoint as Record<string, unknown> | undefined;
  if (!endpoint || !['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(String(endpoint.method)) || typeof endpoint.path !== 'string') {
    fail(file, '`endpoint` needs a `method` and a `path`');
  }
  if (!Array.isArray(m.traffic)) fail(file, '`traffic` must be a list (it may be empty)');
  if (!Array.isArray(m.canaries) || m.canaries.length === 0) fail(file, '`canaries` needs at least one probe');
  if (m.faults !== 'builtin-checkout' && m.faults !== 'none') fail(file, '`faults` must be "builtin-checkout" or "none"');
  if (m.faults === 'builtin-checkout' && !('path' in (source as object))) {
    fail(file, 'the built-in checkout faults only apply to the bundled checkout-api source');
  }
  return { ...(m as unknown as TargetManifest), file };
}

/** `node` in a manifest command means the Node.js that runs Vigil. */
export function resolveCommand(argv: string[]): { cmd: string; args: string[] } {
  const [first, ...rest] = argv;
  return { cmd: first === 'node' ? process.execPath : first, args: rest };
}
