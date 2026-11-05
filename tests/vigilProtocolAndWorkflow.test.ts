import { describe, expect, it, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { SwitchServerHarness } from '../src/mock-switch/switchServerHarness.js';
import { SwitchAgentClient } from '../src/protocol/switchClient.js';
import { startVigilRuntime } from '../src/index.js';

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 6000,
  intervalMs = 40,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for condition`);
}

describe('Vigil — Switch Agent Protocol, Templates & End-to-End War Room', () => {
  let harness: SwitchServerHarness | null = null;
  let runtimeCleanup: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (runtimeCleanup) {
      await runtimeCleanup();
      runtimeCleanup = null;
    }
    if (harness) {
      await harness.stop();
      harness = null;
    }
  });

  it('validates official Switch v1 YAML group and room templates', () => {
    const groupYaml = readFileSync(
      path.resolve(process.cwd(), 'templates/vigil-war-room.template.yaml'),
      'utf8',
    );
    const parsedGroup = YAML.parse(groupYaml) as Record<string, unknown>;
    expect(parsedGroup.version).toBe(1);
    expect(Array.isArray(parsedGroup.agents)).toBe(true);
    expect((parsedGroup.agents as unknown[]).length).toBe(3);
    expect(Array.isArray(parsedGroup.rooms)).toBe(true);
    expect((parsedGroup.rooms as unknown[]).length).toBe(3);
    expect(Array.isArray(parsedGroup.links)).toBe(true);
    expect((parsedGroup.links as unknown[]).length).toBe(3);

    const workroomYaml = readFileSync(
      path.resolve(process.cwd(), 'templates/vigil-hotfix-workroom.template.yaml'),
      'utf8',
    );
    const parsedWorkroom = YAML.parse(workroomYaml) as Record<string, unknown>;
    expect(parsedWorkroom.version).toBe(1);
    expect(parsedWorkroom.room).toBeDefined();
    expect(parsedWorkroom.kickoff).toBeDefined();
  });

  it('enforces Switch WebSocket protocol handshake, 2s ping/pong cursor, role leases, doc authorship & taken_over fencing', async () => {
    harness = new SwitchServerHarness({
      registrationKey: 'reg_test_secret',
      pingIntervalMs: 120,
      heartbeatTtlMs: 1000,
    });
    await harness.start(0);
    const baseUrl = harness.getBaseUrl();

    expect(await SwitchAgentClient.checkHealth(baseUrl)).toBe(true);

    const alphaReg = await SwitchAgentClient.registerAgent(baseUrl, 'reg_test_secret', {
      name: 'alpha-agent',
      description: 'First protocol test agent',
      connector_type: 'test',
      integration_profile: {
        connection_model: 'always_on',
        message_exchange: true,
        pre_invocation_mediation: [],
        post_invocation_mediation: [],
        event_reporting: [],
      },
    });

    // Duplicate registration without `overwrite: true` must fail with 409
    await expect(
      SwitchAgentClient.registerAgent(baseUrl, 'reg_test_secret', {
        name: 'alpha-agent',
        description: 'Duplicate without overwrite',
        connector_type: 'test',
        integration_profile: {
          connection_model: 'always_on',
          message_exchange: true,
          pre_invocation_mediation: [],
          post_invocation_mediation: [],
          event_reporting: [],
        },
      }),
    ).rejects.toThrow(/409/);

    const betaReg = await SwitchAgentClient.registerAgent(baseUrl, 'reg_test_secret', {
      name: 'beta-agent',
      description: 'Second protocol test agent',
      connector_type: 'test',
      integration_profile: {
        connection_model: 'always_on',
        message_exchange: true,
        pre_invocation_mediation: [],
        post_invocation_mediation: [],
        event_reporting: [],
      },
    });

    harness.provisionFromTemplateYaml(
      `
version: 1
room:
  name: test-ops
  agents: ["alpha-agent", "beta-agent"]
  users: ["priya"]
  roles:
    - name: incident-commander
      exclusive: true
      instructions: Exclusive commander
`,
      {},
      'priya',
    );

    const alpha = new SwitchAgentClient({
      baseUrl,
      agentId: alphaReg.id,
      agentName: 'alpha-agent',
      apiKey: alphaReg.api_key,
      connectionId: 'conn-shared-uuid',
    });
    const beta = new SwitchAgentClient({
      baseUrl,
      agentId: betaReg.id,
      agentName: 'beta-agent',
      apiKey: betaReg.api_key,
    });

    const ops = await alpha.discoverOperations();
    expect(ops.assume_role).toBeDefined();
    expect(ops.create_room_document).toBeDefined();

    await alpha.connect();
    await beta.connect();

    const rooms = await alpha.listRooms();
    expect(rooms).toHaveLength(1);
    const roomId = rooms[0].id;

    // Exclusive role lease: alpha claims `incident-commander`, beta gets 409 until alpha releases
    await alpha.assumeRole(roomId, 'incident-commander');
    await expect(beta.assumeRole(roomId, 'incident-commander')).rejects.toThrow(/409/);
    await alpha.releaseRole(roomId, 'incident-commander');
    await expect(beta.assumeRole(roomId, 'incident-commander')).resolves.toMatchObject({
      holder_name: 'beta-agent',
    });

    // Room-scoped document authorship enforcement: beta cannot overwrite alpha's document
    await alpha.createRoomDocument(roomId, {
      name: 'dossier-1',
      description: 'Owned by alpha',
      instructions: 'Read only for others',
      content: 'Initial alpha content',
    });
    await expect(beta.updateRoomDocument(roomId, 'dossier-1', 'Tampered by beta')).rejects.toThrow(
      /403/,
    );

    // Wait >250ms to confirm automatic 120ms ping/pong keeps alpha alive without lapsing
    await new Promise((r) => setTimeout(r, 300));
    expect(alpha.isStoppedPermanently()).toBe(false);

    // Takeover eviction: opening a second client with the same `connectionId` evicts `alpha` permanently
    const alphaTakeover = new SwitchAgentClient({
      baseUrl,
      agentId: alphaReg.id,
      agentName: 'alpha-agent',
      apiKey: alphaReg.api_key,
      connectionId: 'conn-shared-uuid',
    });
    await alphaTakeover.connect();
    await waitFor(() => alpha.isStoppedPermanently());
    expect(alpha.isStoppedPermanently()).toBe(true);

    await alphaTakeover.disconnect();
    await beta.disconnect();
  });

  it('release gate rejects agent handles disguised as human chat senders', async () => {
    const { ReleaseSafetyGate } = await import('../src/gate/releaseSafetyGate.js');
    const base = {
      messageBody: '@vigil-release-gate approve INC-2041 promote',
      activeIncidentId: 'INC-2041',
      knownAgentParticipantIds: new Set<string>(['@switch-agent-vigil-patcher:switch.local']),
      knownAgentNames: new Set<string>(['vigil-sentinel', 'vigil-patcher', 'vigil-release-gate']),
      patchVerification: null,
    };

    // Human-namespaced participant id whose handle collides with a registered agent
    expect(
      ReleaseSafetyGate.evaluate({
        ...base,
        senderParticipantId: '@switch-user-vigil-patcher:switch.local',
        senderName: 'vigil-patcher (Rogue Agent Test)',
      }).reasonCode,
    ).toBe('REJECTED_AGENT_SENDER');

    // Display name with a qualifier suffix, unknown participant id
    expect(
      ReleaseSafetyGate.evaluate({
        ...base,
        senderParticipantId: '@mattermost-bot:switch.local',
        senderName: 'Vigil-Patcher [bot]',
      }).reasonCode,
    ).toBe('REJECTED_AGENT_SENDER');

    // Genuine human is NOT misclassified (falls through to patch-verification invariant)
    expect(
      ReleaseSafetyGate.evaluate({
        ...base,
        senderParticipantId: '@switch-user-priya:switch.local',
        senderName: 'Priya (On-Call Lead)',
      }).reasonCode,
    ).toBe('REJECTED_UNVERIFIED_PATCH');
  });

  it('executes full multi-room incident -> repro/patch -> blocks rogue agent approval -> promotes on human sign-off -> publishes postmortem', async () => {
    const runtime = await startVigilRuntime({ vigilPort: 0, checkoutPort: 0 });
    runtimeCleanup = runtime.stop;

    // Trigger v2.14.0 JPY zero-decimal 500 regression
    const injectRes = await fetch(`${runtime.vigilUrl}/api/chaos/inject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scenarioId: 'jpy_zero_decimal_500' }),
    });
    expect(injectRes.ok).toBe(true);
    const { alert } = (await injectRes.json()) as { alert: { incidentId: string } };
    expect(alert.incidentId).toBe('INC-2041');

    // Wait for Sentinel -> Patcher -> Release Gate autonomous handoff across linked Switch rooms
    await waitFor(() => {
      const inc = runtime.coordinator.getActiveIncident();
      return inc?.stage === 'awaiting_human_gate';
    });

    const gatedIncident = runtime.coordinator.getActiveIncident()!;
    expect(gatedIncident.patchVerification?.reproConfirmed).toBe(true);
    expect(gatedIncident.patchVerification?.allPassed).toBe(true);
    expect(runtime.checkoutService.getTelemetry().status).toBe('degraded');

    const { releasesRoomId, incidentsRoomId, hotfixRoomId } = runtime.coordinator.getRoomIds();

    // Verify room-scoped documents exist in `#vigil-incidents` and `#vigil-hotfix`
    const incDocs = await runtime.coordinator.sentinelClient.loadInternalDocuments(incidentsRoomId);
    expect(incDocs.some((d) => d.name === 'blast-radius-dossier')).toBe(true);

    const hotfixDocs = await runtime.coordinator.patcherClient.loadInternalDocuments(hotfixRoomId);
    expect(hotfixDocs.some((d) => d.name === 'patch-verification-report')).toBe(true);

    // ADVERSARIAL SECURITY CHECK: Rogue / prompt-injected agent attempts to self-approve in `#vigil-releases`!
    await runtime.coordinator.patcherClient.postMessage(
      releasesRoomId,
      `@vigil-release-gate approve INC-2041 promote`,
    );

    await waitFor(() => {
      const inc = runtime.coordinator.getActiveIncident();
      return (inc?.gateDecisions.length ?? 0) >= 1;
    });

    expect(runtime.coordinator.getActiveIncident()?.gateDecisions[0].reasonCode).toBe(
      'REJECTED_AGENT_SENDER',
    );
    // Production is STILL gated and untouched!
    expect(runtime.checkoutService.getTelemetry().deployedVersion).toBe('v2.14.0');

    // ADVERSARIAL CHECK 2 (exact payload sent by the Observatory UI "Test Rogue Agent Block" button):
    // an approval arriving through the team-chat bridge under an agent's handle must still be rejected.
    const uiRogueRes = await fetch(`${runtime.vigilUrl}/api/chat/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        roomId: releasesRoomId,
        username: 'vigil-patcher',
        displayName: 'vigil-patcher (Rogue Agent Test)',
        content: '@vigil-release-gate approve INC-2041 promote',
      }),
    });
    expect(uiRogueRes.ok).toBe(true);
    const uiRoguePosted = (await uiRogueRes.json()) as { sender: string };
    expect(uiRoguePosted.sender.startsWith('@switch-agent-vigil-patcher')).toBe(true);

    await waitFor(() => {
      const inc = runtime.coordinator.getActiveIncident();
      return (inc?.gateDecisions.length ?? 0) >= 2;
    });
    expect(runtime.coordinator.getActiveIncident()?.gateDecisions[1].reasonCode).toBe(
      'REJECTED_AGENT_SENDER',
    );
    expect(runtime.checkoutService.getTelemetry().deployedVersion).toBe('v2.14.0');

    // VERIFIED HUMAN APPROVAL: Priya (On-Call Lead) approves promotion in chat!
    const humanRes = await fetch(`${runtime.vigilUrl}/api/chat/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        roomId: releasesRoomId,
        username: 'priya',
        displayName: 'Priya (On-Call Lead)',
        content: '@vigil-release-gate approve INC-2041 promote',
      }),
    });
    expect(humanRes.ok).toBe(true);

    // Wait for canary probes, postmortem room doc, and Sentinel's closure callback in `#vigil-incidents`
    await waitFor(async () => {
      const inc = runtime.coordinator.getIncidents().find((i) => i.incidentId === 'INC-2041');
      if (inc?.stage !== 'resolved_promoted') return false;
      const roomDetail = await runtime.coordinator.sentinelClient.getRoomDetail(incidentsRoomId);
      const commanderRole = roomDetail.roles.find((r) => r.name === 'incident-commander');
      return commanderRole?.holder_agent_id === null;
    });

    const telemetryAfter = runtime.checkoutService.getTelemetry();
    expect(telemetryAfter.status).toBe('healthy');
    expect(telemetryAfter.deployedVersion).toBe('v2.14.1-hotfix');
    expect(telemetryAfter.errorRatePct).toBe(0);

    const releaseDocs =
      await runtime.coordinator.releaseGateClient.loadInternalDocuments(releasesRoomId);
    expect(releaseDocs.some((d) => d.name === 'postmortem-inc-2041')).toBe(true);
  });

  it('supports instant human-authorized emergency rollback to v2.13.2 on inventory lock cascade', async () => {
    const runtime = await startVigilRuntime({ vigilPort: 0, checkoutPort: 0 });
    runtimeCleanup = runtime.stop;

    const injectRes = await fetch(`${runtime.vigilUrl}/api/chaos/inject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scenarioId: 'inventory_lock_leak_503' }),
    });
    const { alert } = (await injectRes.json()) as { alert: { incidentId: string } };

    await waitFor(
      () => runtime.coordinator.getActiveIncident()?.stage === 'awaiting_human_gate',
    );

    const { releasesRoomId } = runtime.coordinator.getRoomIds();
    await fetch(`${runtime.vigilUrl}/api/chat/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        roomId: releasesRoomId,
        username: 'sam',
        displayName: 'Sam (SRE)',
        content: `@vigil-release-gate approve ${alert.incidentId} rollback`,
      }),
    });

    await waitFor(() => {
      const inc = runtime.coordinator
        .getIncidents()
        .find((i) => i.incidentId === alert.incidentId);
      return inc?.stage === 'resolved_rolled_back';
    });

    expect(runtime.checkoutService.getTelemetry().deployedVersion).toBe('v2.13.2');
    expect(runtime.checkoutService.getTelemetry().status).toBe('healthy');
  });
});
