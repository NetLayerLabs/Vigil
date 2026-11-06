import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { startVigilRuntime } from '../src/index.js';

const dir = mkdtempSync(path.join(tmpdir(), 'vigil-ledger-'));
process.env.VIGIL_LEDGER_FILE = path.join(dir, 'incident-ledger.json');

describe('incident ledger across restarts', () => {
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('keeps incidents through a restart, marks the open one interrupted, and keeps numbering', async () => {
    const first = await startVigilRuntime({ vigilPort: 0, checkoutPort: 0, trafficIntervalMs: 0 });
    const inject = async (vigilUrl: string) =>
      (await (
        await fetch(`${vigilUrl}/api/chaos/inject`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scenarioId: 'jpy_zero_decimal_500' }),
        })
      ).json()) as { alert: { incidentId: string } };
    try {
      expect((await inject(first.vigilUrl)).alert.incidentId).toBe('INC-2041');
      const start = Date.now();
      while (first.coordinator.getActiveIncident()?.stage !== 'awaiting_human_gate' && Date.now() - start < 60_000) {
        await new Promise((r) => setTimeout(r, 100));
      }
      await new Promise((r) => setTimeout(r, 500)); // let the debounced save land
    } finally {
      await first.stop();
    }
    const saved = JSON.parse(readFileSync(process.env.VIGIL_LEDGER_FILE!, 'utf8')) as { incidents: Array<{ incidentId: string; stage: string }> };
    expect(saved.incidents[0]).toMatchObject({ incidentId: 'INC-2041', stage: 'awaiting_human_gate' });

    const second = await startVigilRuntime({ vigilPort: 0, checkoutPort: 0, trafficIntervalMs: 0 });
    try {
      const [restored] = second.coordinator.getIncidents();
      expect(restored.incidentId).toBe('INC-2041');
      expect(restored.stage).toBe('interrupted');
      expect(restored.patchVerification?.allPassed).toBe(true);
      expect(second.coordinator.getActiveIncident()).toBeNull();
      // Nothing is open, so a new release is allowed, and it gets the next number.
      expect((await inject(second.vigilUrl)).alert.incidentId).toBe('INC-2042');
    } finally {
      await second.stop();
    }
  });
});
