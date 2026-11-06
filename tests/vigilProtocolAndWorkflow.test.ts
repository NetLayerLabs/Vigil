import { describe, expect, it, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { SwitchServerHarness } from '../src/mock-switch/switchServerHarness.js';
import { SwitchAgentClient } from '../src/protocol/switchClient.js';
import { startVigilRuntime } from '../src/index.js';

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 30000,
  intervalMs = 60,
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

  it('routes an incident to an external coding agent, verifies its diff, rejects a non-fix, and gates on room-document policy', async () => {
    const runtime = await startVigilRuntime({ vigilPort: 0, checkoutPort: 0 });
    runtimeCleanup = runtime.stop;
    const post = (path: string, body: unknown) =>
      fetch(`${runtime.vigilUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

    // Switch the patcher seat to an external coder (Claude Code bound via Switch Console)
    expect((await post('/api/patch-mode', { mode: 'external' })).ok).toBe(true);
    expect(runtime.coordinator.getPatchMode()).toBe('external');

    const { alert } = (await (await post('/api/chaos/inject', { scenarioId: 'promo_negative_ledger_500' })).json()) as {
      alert: { incidentId: string };
    };
    const incidentId = alert.incidentId;

    // Vigil's patcher arms itself as verifier and waits; nothing is staged yet
    await waitFor(() => runtime.coordinator.getActiveIncident()?.stage === 'reproducing_patching');
    const { hotfixRoomId, releasesRoomId } = runtime.coordinator.getRoomIds();
    await waitFor(async () => {
      const ctx = await runtime.coordinator.patcherClient.readContext(hotfixRoomId, 20);
      return ctx.messages.some((m) => /waiting for @/.test(m.body));
    });
    expect(runtime.coordinator.getActiveIncident()?.patchVerification).toBeNull();
    const hotfixDetail = await runtime.coordinator.patcherClient.getRoomDetail(hotfixRoomId);
    expect(hotfixDetail.roles.find((r) => r.name === 'red-team-verifier')?.holder_name).toBe('vigil-patcher');
    expect(hotfixDetail.roles.find((r) => r.name === 'patch-author')?.holder_name ?? null).toBeNull();

    // Ephemeral workroom was instantiated from the hotfix workroom template and linked
    const inc = runtime.coordinator.getActiveIncident()!;
    expect(inc.workroom?.roomName).toBe(`hotfix-${incidentId.toLowerCase()}`);
    const links = await runtime.coordinator.sentinelClient.listLinkedRooms(hotfixRoomId);
    expect(links.some((l) => l.to_room_id === inc.workroom!.roomId)).toBe(true);
    const workroom = await runtime.coordinator.sentinelClient.getRoomDetail(inc.workroom!.roomId);
    expect(workroom.ephemeral).toBe(true);
    expect(workroom.archived).toBe(false);
    expect(workroom.roles.map((r) => r.name).sort()).toEqual(['patch-author', 'release-gatekeeper']);

    // 1. A diff that does NOT fix the fault is rejected by the verifier and never reaches the gate
    const badRes = await post(`/api/incidents/${incidentId}/stage-patch`, {
      diffUnified: ['--- a/src/services/cartPricing.ts', '+++ b/src/services/cartPricing.ts', '@@ -1 +1 @@', '-// a', '+// b'].join('\n'),
      author: 'claude-code',
    });
    expect(badRes.status).toBe(422);
    const bad = (await badRes.json()) as { verification: { allPassed: boolean; source: string; author: string } };
    expect(bad.verification.allPassed).toBe(false);
    expect(bad.verification.source).toBe('external-coder');
    expect(runtime.coordinator.getActiveIncident()?.stage).toBe('reproducing_patching');
    expect(runtime.checkoutService.getTelemetry().stagedCandidateVersion).toBeNull();

    // 2. The real fix, handed over in chat as a ```diff fence addressed to the verifier (the Switch-native path)
    const referenceFix = (await (await fetch(`${runtime.vigilUrl}/api/incidents/${incidentId}/reference-fix`)).json()) as {
      diffUnified: string;
    };
    await post('/api/chat/message', {
      roomId: hotfixRoomId,
      username: 'claude-code',
      displayName: 'Claude Code',
      content: `@vigil-patcher candidate for ${incidentId}:\n\`\`\`diff\n${referenceFix.diffUnified}\n\`\`\``,
    });
    await waitFor(() => runtime.coordinator.getActiveIncident()?.stage === 'awaiting_human_gate');
    const verified = runtime.coordinator.getActiveIncident()!.patchVerification!;
    expect(verified.allPassed).toBe(true);
    expect(verified.author).toBe('Claude Code');
    expect(verified.source).toBe('external-coder');
    expect(verified.testMatrix.some((t) => /no longer reproduces/.test(t.name) && t.passed)).toBe(true);
    expect(verified.candidateSha).toBeTruthy();

    // 3. Policy lives in the room document: an agent may not change it, a human may
    await runtime.coordinator.patcherClient.postMessage(releasesRoomId, '@vigil-release-gate set max diff 400');
    await waitFor(() => runtime.coordinator.getPolicyAudit().length >= 1);
    expect(runtime.coordinator.getPolicyAudit()[0].accepted).toBe(false);
    expect(runtime.coordinator.getReleasePolicy().maxChangedLines).toBe(40);

    await post('/api/chat/message', {
      roomId: releasesRoomId,
      username: 'priya',
      displayName: 'Priya (On-Call Lead)',
      content: '@vigil-release-gate set max diff 4',
    });
    await waitFor(() => runtime.coordinator.getReleasePolicy().maxChangedLines === 4);
    const policyDoc = (await runtime.coordinator.releaseGateClient.loadInternalDocuments(releasesRoomId)).find(
      (d) => d.name === 'release-safety-policy',
    );
    expect(policyDoc?.content).toMatch(/max_changed_lines: 4\b/);

    // Tightened policy (read live from the room doc) rejects the 7-line candidate
    await post('/api/chat/message', {
      roomId: releasesRoomId,
      username: 'priya',
      displayName: 'Priya (On-Call Lead)',
      content: `@vigil-release-gate approve ${incidentId} promote`,
    });
    await waitFor(() => (runtime.coordinator.getActiveIncident()?.gateDecisions.length ?? 0) >= 1);
    expect(runtime.coordinator.getActiveIncident()?.gateDecisions[0].reasonCode).toBe('REJECTED_DIFF_POLICY_VIOLATION');
    expect(runtime.checkoutService.getTelemetry().deployedVersion).toBe('v2.14.0');

    // Restrict approvers to Sam, then Priya is refused even with a sane cap
    await post('/api/chat/message', {
      roomId: releasesRoomId,
      username: 'priya',
      displayName: 'Priya (On-Call Lead)',
      content: '@vigil-release-gate set max diff 60',
    });
    await waitFor(() => runtime.coordinator.getReleasePolicy().maxChangedLines === 60);
    await post('/api/chat/message', {
      roomId: releasesRoomId,
      username: 'priya',
      displayName: 'Priya (On-Call Lead)',
      content: '@vigil-release-gate set approvers sam',
    });
    await waitFor(() => runtime.coordinator.getReleasePolicy().allowedApprovers.join() === 'sam');
    await post('/api/chat/message', {
      roomId: releasesRoomId,
      username: 'priya',
      displayName: 'Priya (On-Call Lead)',
      content: `@vigil-release-gate approve ${incidentId} promote`,
    });
    await waitFor(() => (runtime.coordinator.getActiveIncident()?.gateDecisions.length ?? 0) >= 2);
    expect(runtime.coordinator.getActiveIncident()?.gateDecisions[1].reasonCode).toBe('REJECTED_UNAUTHORIZED_APPROVER');

    // Sam approves: promotion, canary, postmortem, and the ephemeral workroom is archived at closure
    await post('/api/chat/message', {
      roomId: releasesRoomId,
      username: 'sam',
      displayName: 'Sam (SRE)',
      content: `@vigil-release-gate approve ${incidentId} promote`,
    });
    await waitFor(async () => {
      const rec = runtime.coordinator.getIncidents().find((i) => i.incidentId === incidentId);
      return rec?.stage === 'resolved_promoted' && rec.workroom?.archived === true;
    }, 30000);
    const finalRec = runtime.coordinator.getIncidents().find((i) => i.incidentId === incidentId)!;
    expect(finalRec.finalVersion).toBe('v2.14.1-hotfix');
    expect(finalRec.canaryReport?.probesPassed).toBe(5);
    const archivedRoom = await runtime.coordinator.sentinelClient.getRoomDetail(finalRec.workroom!.roomId);
    expect(archivedRoom.archived).toBe(true);
    await expect(
      runtime.coordinator.sentinelClient.postMessage(finalRec.workroom!.roomId, 'late message'),
    ).rejects.toThrow(/409/);
  });

  it('fails over the incident commander: wedged sentinel is evicted with taken_over, standby resumes from cursor and keeps the lease', async () => {
    const runtime = await startVigilRuntime({ vigilPort: 0, checkoutPort: 0 });
    runtimeCleanup = runtime.stop;
    const post = (path: string, body?: unknown) =>
      fetch(`${runtime.vigilUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });

    // Agents widened their addressing at bootstrap (a fresh Switch agent answers only its owner)
    const snapshot = runtime.embeddedSwitch!.getSnapshot();
    expect(snapshot.agents.length).toBe(3);

    await post('/api/chaos/inject', { scenarioId: 'jpy_zero_decimal_500' });
    await waitFor(() => runtime.coordinator.getActiveIncident()?.stage === 'awaiting_human_gate');
    const { incidentsRoomId, releasesRoomId } = runtime.coordinator.getRoomIds();

    const before = runtime.coordinator.sentinelClient;
    const beforeGen = before.getGeneration();

    // Wedge the commander mid-incident: socket open, pings unanswered
    const crash = (await (await post('/api/chaos/crash-sentinel')).json()) as { hung: { generation: number } };
    expect(crash.hung.generation).toBe(beforeGen);
    expect(before.isHung()).toBe(true);
    // A hung client stops advancing its cursor, so read it now: room traffic may still have been
    // arriving right up to the crash.
    const beforeCursor = before.getCursor();
    expect(beforeCursor).toBeGreaterThan(0);
    const leaseBefore = (await runtime.coordinator.releaseGateClient.getRoomDetail(incidentsRoomId)).roles.find(
      (r) => r.name === 'incident-commander',
    );
    expect(leaseBefore?.holder_name).toBe('vigil-sentinel');

    // Standby takes over the same connection_id from the last cursor
    const fo = (await (await post('/api/chaos/failover-sentinel')).json()) as {
      failover: { previousGeneration: number; newGeneration: number; resumedFromCursor: number; leaseReclaimed: boolean };
    };
    expect(fo.failover.previousGeneration).toBe(beforeGen);
    expect(fo.failover.newGeneration).toBeGreaterThan(beforeGen ?? 0);
    expect(fo.failover.resumedFromCursor).toBe(beforeCursor);
    expect(fo.failover.leaseReclaimed).toBe(true);

    const after = runtime.coordinator.sentinelClient;
    expect(after).not.toBe(before);
    expect(after.connectionId).toBe(before.connectionId);
    await waitFor(() => before.isStoppedPermanently()); // old socket got `evicted: taken_over` and halted for good
    expect(runtime.coordinator.getRetiredSentinels()[0].evicted).toBe(true);

    const leaseAfter = (await after.getRoomDetail(incidentsRoomId)).roles.find((r) => r.name === 'incident-commander');
    expect(leaseAfter?.holder_name).toBe('vigil-sentinel');

    // The incident still completes through the new commander: closure callback lands on the standby
    await post('/api/chat/message', {
      roomId: releasesRoomId,
      username: 'priya',
      displayName: 'Priya (On-Call Lead)',
      content: '@vigil-release-gate approve INC-2041 promote',
    });
    await waitFor(async () => {
      const ctx = await after.readContext(incidentsRoomId, 30);
      return ctx.messages.some((m) => /INC-2041 closed/.test(m.body));
    }, 30000);
    const finalRoles = (await after.getRoomDetail(incidentsRoomId)).roles.find((r) => r.name === 'incident-commander');
    expect(finalRoles?.holder_name ?? null).toBeNull();
    expect(after.isHung()).toBe(false);
    expect(after.isStoppedPermanently()).toBe(false);
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
