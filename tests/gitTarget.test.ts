import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadTargetManifest } from '../src/services/targetManifest.js';

// A service Vigil has never seen: its own git repository with a release tag, described by a manifest
// that points at it by URL. (Built from the demo service's code so it runs without network access.)
const root = mkdtempSync(path.join(tmpdir(), 'vigil-git-target-'));
const repo = path.join(root, 'payments-api');
cpSync(path.resolve('services/checkout-api'), repo, { recursive: true, filter: (src) => !src.includes('releases') });
const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
writeFileSync(path.join(repo, 'VERSION'), 'r42\n');
git('init', '-q', '-b', 'main');
git('add', '-A');
git('-c', 'user.name=Release', '-c', 'user.email=release@example.com', 'commit', '-q', '-m', 'release r42');
git('tag', 'r42');

const manifest = path.join(root, 'payments.target.json');
writeFileSync(
  manifest,
  JSON.stringify({
    name: 'payments-api',
    source: { git: `file://${repo}` },
    versions: { lastKnownGood: 'r42', hotfix: 'r42-hotfix' },
    codePaths: ['src', 'test'],
    // The clone borrows this repository's node_modules instead of installing over the network.
    install: ['ln', '-s', path.resolve('node_modules'), 'node_modules'],
    start: ['node', '--import', 'tsx', 'src/server.ts'],
    test: ['node', '--import', 'tsx', '--test', 'test/cartPricing.test.ts'],
    portEnv: ['PORT'],
    healthPath: '/health',
    endpoint: { method: 'POST', path: '/api/checkout' },
    traffic: [],
    canaries: [{ name: 'USD order', body: { cartId: 'probe', currency: 'USD', items: [{ sku: 'PRO', qty: 1, unitPriceMajor: 10 }] } }],
    faults: 'none',
  }),
);
process.env.VIGIL_TARGET = manifest;

describe('a target from its own git repository', () => {
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('rejects a manifest with a missing field, with the field named', () => {
    const bad = path.join(root, 'bad.target.json');
    writeFileSync(bad, JSON.stringify({ name: 'x', source: { path: '.' }, versions: { lastKnownGood: 'a', hotfix: 'b' } }));
    expect(() => loadTargetManifest(bad)).toThrow(/`codePaths`/);
  });

  it('clones it, runs it from its release tag, probes it, and keeps chaos releases off', async () => {
    const { startVigilRuntime } = await import('../src/index.js');
    const runtime = await startVigilRuntime({ vigilPort: 0, checkoutPort: 0, trafficIntervalMs: 0 });
    try {
      const workDir = runtime.checkoutService.getWorkDir();
      expect(path.basename(workDir)).toMatch(/^payments-api-live-/);
      expect(execFileSync('git', ['-C', workDir, 'describe', '--tags'], { encoding: 'utf8' }).trim()).toBe('r42');

      const health = (await (await fetch(`${runtime.checkoutUrl}/health`)).json()) as { deployedVersion: string; status: string };
      expect(health).toMatchObject({ deployedVersion: 'r42', status: 'healthy' });

      const canary = await runtime.checkoutService.runSyntheticCanaryProbes();
      expect(canary).toMatchObject({ probesRun: 1, probesPassed: 1, healthy: true });
      expect(canary.details[0]).toMatch(/^USD order: 200 OK/);

      const chaos = await fetch(`${runtime.vigilUrl}/api/chaos/inject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scenarioId: 'jpy_zero_decimal_500' }),
      });
      expect(chaos.ok).toBe(false);
      expect(JSON.stringify(await chaos.json())).toMatch(/Chaos releases are off for payments-api/);
    } finally {
      await runtime.stop();
    }
  });
});
