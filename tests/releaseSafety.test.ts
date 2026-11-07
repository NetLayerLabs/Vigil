import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_RELEASE_POLICY, handleFromParticipantId, ReleaseSafetyGate } from '../src/gate/releaseSafetyGate.js';
import type { PatchVerificationResult } from '../src/services/checkoutTarget.js';
import { startVigilRuntime } from '../src/index.js';

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 60));
  }
  throw new Error(`Timed out after ${timeoutMs}ms`);
}

const verified: PatchVerificationResult = {
  scenarioId: 'jpy_zero_decimal_500',
  reproConfirmed: true,
  reproErrorOutput: 'HTTP 500 TypeError',
  candidateVersion: 'v2.14.1-hotfix',
  candidateSha: 'abc1234',
  diffUnified: '+fix',
  changedLines: 12,
  touchedFiles: ['services/checkout-api/src/cartPricing.ts'],
  testMatrix: [
    { name: 'a', passed: true, detail: 'passed' },
    { name: 'b', passed: true, detail: 'passed' },
  ],
  allPassed: true,
  testRunOutput: '',
  author: 'vigil-patcher',
  source: 'vigil-patcher',
};

const attempt = (over: Partial<Parameters<typeof ReleaseSafetyGate.evaluate>[0]>) =>
  ReleaseSafetyGate.evaluate({
    senderParticipantId: '@switch-user-priya:switch.local',
    senderName: 'priya',
    messageBody: '@vigil-release-gate approve INC-2041 promote',
    activeIncidentId: 'INC-2041',
    knownAgentParticipantIds: new Set(),
    knownAgentNames: new Set(['vigil-patcher']),
    patchVerification: verified,
    lastKnownGoodVersion: 'v2.13.2',
    policy: DEFAULT_RELEASE_POLICY,
    ...over,
  });

describe('release gate rules', () => {
  it('reads chat handles from participant ids', () => {
    expect(handleFromParticipantId('@switch-user-priya:switch.local')).toBe('priya');
    expect(handleFromParticipantId('@switch-mattermost-e28510fb-6ade-4d55-8089-933e6766c830-priya:localhost')).toBe('priya');
    expect(handleFromParticipantId('@switch-admin:localhost')).toBe('');
  });

  it('fails closed on senders it cannot identify as people', () => {
    expect(attempt({}).reasonCode).toBe('APPROVED_PROMOTE');
    expect(attempt({ senderParticipantId: '@switch-mattermost-e28510fb-6ade-4d55-8089-933e6766c830-priya:localhost' }).reasonCode).toBe('APPROVED_PROMOTE');
    expect(attempt({ senderParticipantId: '@something-else:localhost', senderName: 'priya' }).reasonCode).toBe('REJECTED_AGENT_SENDER');
    expect(attempt({ senderKind: 'platform' }).reasonCode).toBe('REJECTED_AGENT_SENDER');
    expect(attempt({ senderParticipantId: '@switch-agent-3a1b:localhost', senderName: 'Priya' }).reasonCode).toBe('REJECTED_AGENT_SENDER');
  });

  it('matches approvers on their chat handle, not a display name they can change', () => {
    const policy = { ...DEFAULT_RELEASE_POLICY, allowedApprovers: ['sam'] };
    const mm = (handle: string) => `@switch-mattermost-e28510fb-6ade-4d55-8089-933e6766c830-${handle}:localhost`;
    expect(attempt({ policy, senderParticipantId: mm('sam'), senderName: 'Sam' }).reasonCode).toBe('APPROVED_PROMOTE');
    expect(attempt({ policy, senderParticipantId: mm('mallory'), senderName: 'sam' }).reasonCode).toBe('REJECTED_UNAUTHORIZED_APPROVER');
  });

  it('never approves shipping a candidate that was discarded, even with green tests switched off', () => {
    const policy = { ...DEFAULT_RELEASE_POLICY, requireGreenMatrix: false };
    const discarded = { ...verified, allPassed: false, candidateSha: null };
    const decision = attempt({ policy, patchVerification: discarded });
    expect(decision.reasonCode).toBe('REJECTED_UNVERIFIED_PATCH');
    expect(decision.explanation).toMatch(/discarded/);
  });

  it('explains approvals with real numbers and the real rollback target', () => {
    const mixed = { ...verified, testMatrix: [...verified.testMatrix, { name: 'c', passed: false, detail: 'x' }], allPassed: false };
    const decision = attempt({ policy: { ...DEFAULT_RELEASE_POLICY, requireGreenMatrix: false }, patchVerification: mixed });
    expect(decision.explanation).toContain('2 of 3 checks passed');
    expect(attempt({ messageBody: '@vigil-release-gate approve INC-2041 rollback', lastKnownGoodVersion: 'r42' }).explanation).toContain('r42');
  });
});

describe('release flow on a running instance', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (cleanup) await cleanup();
    cleanup = null;
  });

  it('keeps the incident open when the canaries do not meet min_canary_probes', async () => {
    const runtime = await startVigilRuntime({ vigilPort: 0, checkoutPort: 0, trafficIntervalMs: 0 });
    cleanup = runtime.stop;
    const say = (content: string) =>
      fetch(`${runtime.vigilUrl}/api/chat/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomId: runtime.coordinator.getRoomIds().releasesRoomId, username: 'priya', displayName: 'priya', content }),
      });
    const gateSays = async (re: RegExp) => {
      const ctx = await runtime.coordinator.releaseGateClient.readContext(runtime.coordinator.getRoomIds().releasesRoomId, 40);
      return ctx.messages.some((m) => m.sender_name !== 'priya' && re.test(m.body));
    };

    await say('@vigil-release-gate set canary probes 6'); // the demo service has 5 canaries
    await waitFor(() => runtime.coordinator.getReleasePolicy().minCanaryProbes === 6);
    await fetch(`${runtime.vigilUrl}/api/chaos/inject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scenarioId: 'jpy_zero_decimal_500' }),
    });
    await waitFor(() => runtime.coordinator.getActiveIncident()?.stage === 'awaiting_human_gate');

    await say('@vigil-release-gate approve INC-2041 promote');
    await waitFor(() => gateSays(/INC-2041: not closing/));
    const open = runtime.coordinator.getActiveIncident()!;
    expect(open.stage).toBe('awaiting_human_gate');
    expect(open.resolvedAt).toBeNull();
    expect(open.canaryReport?.probesPassed).toBe(5);

    // With the policy back at 5, the same release closes, and the closure reports the real counts.
    await say('@vigil-release-gate set canary probes 5');
    await waitFor(() => runtime.coordinator.getReleasePolicy().minCanaryProbes === 5);
    await say('@vigil-release-gate approve INC-2041 promote');
    await waitFor(() => runtime.coordinator.getIncidents()[0].stage === 'resolved_promoted');
    const ctx = await runtime.coordinator.sentinelClient.readContext(runtime.coordinator.getRoomIds().incidentsRoomId, 40);
    await waitFor(async () =>
      (await runtime.coordinator.sentinelClient.readContext(runtime.coordinator.getRoomIds().incidentsRoomId, 40)).messages.some((m) =>
        /INC-2041 closed\.\*\* `v2\.14\.1-hotfix` is live; 5 of 5 canary probes passed/.test(m.body),
      ),
    );
    expect(ctx.messages.some((m) => /5\/5 canary/.test(m.body))).toBe(false);

    // An approval with nothing open gets an answer instead of silence.
    await say('@vigil-release-gate approve INC-2041 promote');
    await waitFor(() => gateSays(/INC-2041 is already resolved promoted/));
  });

  it('decides releases only in the releases room', async () => {
    const runtime = await startVigilRuntime({ vigilPort: 0, checkoutPort: 0, trafficIntervalMs: 0 });
    cleanup = runtime.stop;
    const rooms = runtime.coordinator.getRoomIds();
    const say = (roomId: string, content: string) =>
      fetch(`${runtime.vigilUrl}/api/chat/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomId, username: 'priya', displayName: 'priya', content }),
      });
    await fetch(`${runtime.vigilUrl}/api/chaos/inject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scenarioId: 'jpy_zero_decimal_500' }),
    });
    await waitFor(() => runtime.coordinator.getActiveIncident()?.stage === 'awaiting_human_gate');

    await say(rooms.hotfixRoomId, '@vigil-release-gate approve INC-2041 promote');
    await new Promise((r) => setTimeout(r, 1500));
    const inc = runtime.coordinator.getActiveIncident()!;
    expect(inc.gateDecisions).toHaveLength(0);
    expect(inc.stage).toBe('awaiting_human_gate');

    await say(rooms.releasesRoomId, '@vigil-release-gate approve INC-2041 promote');
    await waitFor(() => runtime.coordinator.getIncidents()[0].stage === 'resolved_promoted');
  });

  it('stops the guarded service when Vigil gets SIGTERM', async () => {
    const child = spawn(process.execPath, [path.resolve('dist/server/index.js')], {
      cwd: path.resolve('.'),
      env: { ...process.env, VIGIL_PORT: '0', CHECKOUT_API_PORT: '0', CHECKOUT_TRAFFIC_INTERVAL_MS: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => (out += String(d)));
    await waitFor(() => /Checkout API Target : http:\/\/localhost:(\d+)/.test(out), 30_000);
    const port = Number(out.match(/Checkout API Target : http:\/\/localhost:(\d+)/)![1]);
    expect((await fetch(`http://127.0.0.1:${port}/health`)).ok).toBe(true);

    child.kill('SIGTERM');
    await new Promise((r) => child.once('exit', r));
    const listening = () =>
      new Promise<boolean>((resolve) => {
        const sock = connect(port, '127.0.0.1');
        sock.once('connect', () => (sock.destroy(), resolve(true)));
        sock.once('error', () => resolve(false));
      });
    await waitFor(async () => !(await listening()), 10_000);
  });
});
