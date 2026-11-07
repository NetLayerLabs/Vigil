import { afterEach, describe, expect, it } from 'vitest';
import { startVigilRuntime } from '../src/index.js';

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 60));
  }
  throw new Error(`Timed out after ${timeoutMs}ms`);
}

describe('external coder fallback', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (cleanup) await cleanup();
    cleanup = null;
    delete process.env.VIGIL_EXTERNAL_TIMEOUT_MS;
  });

  async function externalRun() {
    process.env.VIGIL_EXTERNAL_TIMEOUT_MS = '2500';
    const runtime = await startVigilRuntime({ vigilPort: 0, checkoutPort: 0, trafficIntervalMs: 0 });
    cleanup = runtime.stop;
    const post = (path: string, body: unknown) =>
      fetch(`${runtime.vigilUrl}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    await post('/api/patch-mode', { mode: 'external' });
    await post('/api/chaos/inject', { scenarioId: 'jpy_zero_decimal_500' });
    await waitFor(() => runtime.coordinator.getActiveIncident()?.stage === 'reproducing_patching');
    const hotfix = () => runtime.coordinator.patcherClient.readContext(runtime.coordinator.getRoomIds().hotfixRoomId, 60);
    return { runtime, post, hotfix };
  }

  it('writes the fix itself when the coding agent never answers, and still stops at the human gate', async () => {
    const { runtime, hotfix } = await externalRun();
    await waitFor(() => runtime.coordinator.getActiveIncident()?.stage === 'awaiting_human_gate', 30_000);
    const inc = runtime.coordinator.getActiveIncident()!;
    expect(inc.patchVerification?.author).toBe('vigil-patcher');
    expect(inc.patchVerification?.allPassed).toBe(true);
    expect(inc.resolvedAt).toBeNull();
    expect((await hotfix()).messages.some((m) => /has not answered in 3 seconds, so I'm writing the fix myself/.test(m.body))).toBe(true);
  });

  it('leaves a coding agent that has answered alone', async () => {
    const { runtime, post, hotfix } = await externalRun();
    await post('/api/chat/message', {
      roomId: runtime.coordinator.getRoomIds().hotfixRoomId,
      username: 'claude-code',
      displayName: 'claude-code',
      content: 'Reproducing INC-2041 now.',
    });
    await new Promise((r) => setTimeout(r, 4500));
    expect(runtime.coordinator.getActiveIncident()?.stage).toBe('reproducing_patching');
    expect((await hotfix()).messages.some((m) => /writing the fix myself/.test(m.body))).toBe(false);
  });
});
