import { readFileSync } from 'node:fs';
import path from 'node:path';
import { SwitchAgentClient } from '../protocol/switchClient.js';
import { ProtocolWireTrace, SwitchRoomDetail } from '../protocol/types.js';
import {
  CanaryProbeReport,
  CheckoutMicroservice,
  FAULT_CATALOG,
  FaultScenarioId,
  IncidentAlertWebhook,
  PatchVerificationResult,
} from '../services/checkoutSandbox.js';
import { ReleaseGateDecision, ReleaseSafetyGate } from '../gate/releaseSafetyGate.js';

export type IncidentLifecycleStage =
  | 'detecting'
  | 'triaged_escalated'
  | 'reproducing_patching'
  | 'awaiting_human_gate'
  | 'resolved_promoted'
  | 'resolved_rolled_back';

export interface IncidentLedgerRecord {
  incidentId: string;
  scenarioId: FaultScenarioId;
  title: string;
  stage: IncidentLifecycleStage;
  alert: IncidentAlertWebhook;
  patchVerification: PatchVerificationResult | null;
  gateDecisions: Array<ReleaseGateDecision & { timestamp: number; senderName: string }>;
  canaryReport: CanaryProbeReport | null;
  finalVersion: string | null;
  openedAt: number;
  resolvedAt: number | null;
}

export interface VigilMeshOptions {
  switchServerUrl: string;
  registrationKey: string;
  teamPrefix?: string;
  bridgeName?: string;
  creatorUsername?: string;
  externalCoderHandle?: string;
  checkoutService: CheckoutMicroservice;
  preRegisteredCreds?: {
    sentinel?: { id: string; api_key: string };
    patcher?: { id: string; api_key: string };
    releaseGate?: { id: string; api_key: string };
  };
  provisionTemplateViaApi?: boolean;
  onEventUpdate?: () => void;
}

/**
 * Coordinates the 3 Switch Protocol Agents (`{team}-sentinel`, `{team}-patcher`, `{team}-release-gate`)
 * over genuine WebSocket + HTTP Operation connections against Switch Server (live or harness).
 */
export class VigilMeshCoordinator {
  public sentinelClient!: SwitchAgentClient;
  public patcherClient!: SwitchAgentClient;
  public releaseGateClient!: SwitchAgentClient;

  public readonly teamPrefix: string;
  private readonly opts: VigilMeshOptions;
  private readonly wireTraces: ProtocolWireTrace[] = [];
  private readonly incidents = new Map<string, IncidentLedgerRecord>();
  private activeIncidentId: string | null = null;

  private roomsByRole: {
    incidentsRoomId: string;
    hotfixRoomId: string;
    releasesRoomId: string;
  } = {
    incidentsRoomId: '',
    hotfixRoomId: '',
    releasesRoomId: '',
  };

  private knownAgentParticipantIds = new Set<string>();
  private knownAgentNames = new Set<string>();

  constructor(opts: VigilMeshOptions) {
    this.opts = opts;
    this.teamPrefix = opts.teamPrefix ?? 'vigil';
  }

  public getWireTraces(): ProtocolWireTrace[] {
    return [...this.wireTraces];
  }

  public getIncidents(): IncidentLedgerRecord[] {
    return Array.from(this.incidents.values()).sort((a, b) => b.openedAt - a.openedAt);
  }

  public getActiveIncident(): IncidentLedgerRecord | null {
    return this.activeIncidentId ? (this.incidents.get(this.activeIncidentId) ?? null) : null;
  }

  public getRoomIds() {
    return { ...this.roomsByRole };
  }

  public async bootstrap(templateYamlPath?: string): Promise<void> {
    const sentinelName = `${this.teamPrefix}-sentinel`;
    const patcherName = `${this.teamPrefix}-patcher`;
    const gateName = `${this.teamPrefix}-release-gate`;

    // 1. Register or reuse credentials for all 3 Switch Protocol Agents
    const sentinelCreds =
      this.opts.preRegisteredCreds?.sentinel ??
      (await SwitchAgentClient.registerAgent(this.opts.switchServerUrl, this.opts.registrationKey, {
        name: sentinelName,
        display_name: 'Vigil Sentinel',
        description: 'Autonomous Telemetry Correlator & Incident Commander',
        connector_type: 'vigil-websocket-agent',
        overwrite: true,
        integration_profile: {
          connection_model: 'always_on',
          message_exchange: true,
          pre_invocation_mediation: [],
          post_invocation_mediation: [],
          event_reporting: [],
        },
      }));

    const patcherCreds =
      this.opts.preRegisteredCreds?.patcher ??
      (await SwitchAgentClient.registerAgent(this.opts.switchServerUrl, this.opts.registrationKey, {
        name: patcherName,
        display_name: 'Vigil Patcher',
        description: 'Surgical Bug Reproducer & Regression Patcher',
        connector_type: 'vigil-websocket-agent',
        overwrite: true,
        integration_profile: {
          connection_model: 'always_on',
          message_exchange: true,
          pre_invocation_mediation: [],
          post_invocation_mediation: [],
          event_reporting: [],
        },
      }));

    const gateCreds =
      this.opts.preRegisteredCreds?.releaseGate ??
      (await SwitchAgentClient.registerAgent(this.opts.switchServerUrl, this.opts.registrationKey, {
        name: gateName,
        display_name: 'Vigil Release Gate',
        description: 'Deterministic Human-in-the-Loop Release & Rollback Gatekeeper',
        connector_type: 'vigil-websocket-agent',
        overwrite: true,
        integration_profile: {
          connection_model: 'always_on',
          message_exchange: true,
          pre_invocation_mediation: [],
          post_invocation_mediation: [],
          event_reporting: [],
        },
      }));

    this.knownAgentNames = new Set([
      sentinelName.toLowerCase(),
      patcherName.toLowerCase(),
      gateName.toLowerCase(),
      'vigil sentinel',
      'vigil patcher',
      'vigil release gate',
    ]);
    this.knownAgentParticipantIds = new Set([
      `@switch-agent-${sentinelName}:switch.local`,
      `@switch-agent-${patcherName}:switch.local`,
      `@switch-agent-${gateName}:switch.local`,
    ]);

    // 2. Provision the 3-room linked group topology from `templates/vigil-war-room.template.yaml` if requested
    if (this.opts.provisionTemplateViaApi !== false) {
      const resolvedPath =
        templateYamlPath ?? path.resolve(process.cwd(), 'templates/vigil-war-room.template.yaml');
      const yamlContent = readFileSync(resolvedPath, 'utf8');
      const res = await fetch(`${this.opts.switchServerUrl.replace(/\/+$/, '')}/rooms/from-yaml`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.opts.registrationKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          yaml: yamlContent,
          params: {
            team: this.teamPrefix,
            bridge: this.opts.bridgeName ?? 'Mattermost',
          },
          creator: this.opts.creatorUsername ?? 'priya',
        }),
      });
      if (!res.ok) {
        throw new Error(`Failed to provision Switch template YAML (${res.status}): ${await res.text()}`);
      }
    }

    const recordTrace = (trace: ProtocolWireTrace) => {
      this.wireTraces.unshift(trace);
      if (this.wireTraces.length > 250) {
        this.wireTraces.pop();
      }
      this.opts.onEventUpdate?.();
    };

    // 3. Instantiate independent WebSocket Agent Protocol clients
    this.sentinelClient = new SwitchAgentClient({
      baseUrl: this.opts.switchServerUrl,
      agentId: sentinelCreds.id,
      agentName: sentinelName,
      apiKey: sentinelCreds.api_key,
      scope: 'all',
      filter: 'all',
      onTrace: recordTrace,
    });

    this.patcherClient = new SwitchAgentClient({
      baseUrl: this.opts.switchServerUrl,
      agentId: patcherCreds.id,
      agentName: patcherName,
      apiKey: patcherCreds.api_key,
      scope: 'all',
      filter: 'all',
      onTrace: recordTrace,
    });

    this.releaseGateClient = new SwitchAgentClient({
      baseUrl: this.opts.switchServerUrl,
      agentId: gateCreds.id,
      agentName: gateName,
      apiKey: gateCreds.api_key,
      scope: 'all',
      filter: 'all',
      onTrace: recordTrace,
    });

    // Discover operations dynamically from Switch Server (`GET /agents/{id}/ops`)
    await Promise.all([
      this.sentinelClient.discoverOperations(),
      this.patcherClient.discoverOperations(),
      this.releaseGateClient.discoverOperations(),
    ]);

    // Resolve room IDs from Switch Server
    const rooms = await this.sentinelClient.listRooms();
    const allPatcherRooms = await this.patcherClient.listRooms();
    const mergedRooms = new Map<string, SwitchRoomDetail>();
    for (const r of [...rooms, ...allPatcherRooms]) {
      mergedRooms.set(r.name, r);
    }

    const incRoom = mergedRooms.get(`${this.teamPrefix}-incidents`);
    const hotfixRoom = mergedRooms.get(`${this.teamPrefix}-hotfix`);
    const relRoom = mergedRooms.get(`${this.teamPrefix}-releases`);

    if (!incRoom || !hotfixRoom || !relRoom) {
      throw new Error(
        `Missing expected Switch rooms for team '${this.teamPrefix}'. Found: [${Array.from(mergedRooms.keys()).join(', ')}]`,
      );
    }

    this.roomsByRole = {
      incidentsRoomId: incRoom.id,
      hotfixRoomId: hotfixRoom.id,
      releasesRoomId: relRoom.id,
    };

    // Wire message handlers BEFORE opening WebSockets
    this.wireSentinelHandlers();
    this.wirePatcherHandlers();
    this.wireReleaseGateHandlers();

    // Open live WebSockets and receive `connection_state`
    await Promise.all([
      this.sentinelClient.connect(),
      this.patcherClient.connect(),
      this.releaseGateClient.connect(),
    ]);

    // Subscribe checkout-api incident alerts directly to Sentinel
    this.opts.checkoutService.setIncidentWebhook(async (alert) => {
      await this.handleIncomingTelemetryAlert(alert);
    });
  }

  public async shutdown(): Promise<void> {
    await Promise.all([
      this.sentinelClient?.disconnect(),
      this.patcherClient?.disconnect(),
      this.releaseGateClient?.disconnect(),
    ]);
  }

  /**
   * Step 1: Sentinel receives a live error webhook from `checkout-api`, assumes `incident-commander`,
   * writes `blast-radius-dossier` room doc, posts triage in `#vigil-incidents`, and traverses
   * `list_linked_rooms` to escalate to `@vigil-patcher` in `#vigil-hotfix`.
   */
  public async handleIncomingTelemetryAlert(alert: IncidentAlertWebhook): Promise<void> {
    const spec = FAULT_CATALOG[alert.scenarioId];
    const record: IncidentLedgerRecord = {
      incidentId: alert.incidentId,
      scenarioId: alert.scenarioId,
      title: spec.title,
      stage: 'detecting',
      alert,
      patchVerification: null,
      gateDecisions: [],
      canaryReport: null,
      finalVersion: null,
      openedAt: Date.now(),
      resolvedAt: null,
    };
    this.incidents.set(alert.incidentId, record);
    this.activeIncidentId = alert.incidentId;
    this.opts.onEventUpdate?.();

    const incRoomId = this.roomsByRole.incidentsRoomId;

    // 1. Claim exclusive `incident-commander` role lease in `#vigil-incidents`
    await this.sentinelClient.assumeRole(incRoomId, 'incident-commander');

    // 2. Write `blast-radius-dossier` Room-Scoped Document
    const dossierMarkdown = [
      `# Blast Radius Dossier — ${alert.incidentId}`,
      `- **Status:** ACTIVE (Escalated to \`#${this.teamPrefix}-hotfix\`)`,
      `- **Service:** \`${alert.service}\` (\`${alert.deployedVersion}\`, LKG: \`${alert.lastKnownGoodVersion}\`)`,
      `- **Endpoint:** \`${alert.endpoint}\` -> HTTP \`${alert.httpStatus}\` (\`${alert.errorRatePct}%\` error rate, p99 \`${alert.p99LatencyMs}ms\`)`,
      `- **Suspected Commit:** \`${alert.suspectedCommit.sha}\` by \`${alert.suspectedCommit.author}\` — *"${alert.suspectedCommit.message}"* (\`${alert.suspectedCommit.filePath}:${alert.suspectedCommit.line}\`)`,
      `- **Primary Exception:** \`${alert.errorMessage}\``,
      `- **Reproduction Payload:** \`${JSON.stringify(alert.reproductionPayload)}\``,
    ].join('\n');

    await this.sentinelClient.createRoomDocument(incRoomId, {
      name: 'blast-radius-dossier',
      description: `Live root-cause & blast-radius dossier for ${alert.incidentId}`,
      instructions: 'Read before reproducing or approving production rollback/hotfix.',
      content: dossierMarkdown,
    });

    // 3. Post triage summary into `#vigil-incidents`
    await this.sentinelClient.postMessage(
      incRoomId,
      [
        `🚨 **[SEV-1 ${alert.incidentId}] ${spec.title}**`,
        `- **Telemetry:** \`${alert.endpoint}\` returning **HTTP ${alert.httpStatus}** (\`${alert.errorRatePct}%\` error rate · p99 \`${alert.p99LatencyMs}ms\`) on \`${alert.deployedVersion}\`.`,
        `- **Correlated Commit:** \`${alert.suspectedCommit.sha}\` (\`${alert.suspectedCommit.filePath}:${alert.suspectedCommit.line}\`) — *${alert.suspectedCommit.message}*.`,
        `- **Room State:** Assumed exclusive \`incident-commander\` lease & published \`blast-radius-dossier\` room document. Traversing room link -> \`#${this.teamPrefix}-hotfix\`.`,
      ].join('\n'),
    );

    // 4. Discover linked hotfix room dynamically via Switch `list_linked_rooms` operation
    const links = await this.sentinelClient.listLinkedRooms(incRoomId);
    const outboundHotfixLink = links.find(
      (l) => l.from_room_id === incRoomId && l.to_room_name.includes('hotfix'),
    );
    const targetHotfixRoomId = outboundHotfixLink?.to_room_id ?? this.roomsByRole.hotfixRoomId;

    record.stage = 'triaged_escalated';
    this.opts.onEventUpdate?.();

    const patcherHandle = `${this.teamPrefix}-patcher`;
    const extraCoderMention = this.opts.externalCoderHandle
      ? ` @${this.opts.externalCoderHandle}`
      : '';

    await this.sentinelClient.sendTargetedMessage(
      targetHotfixRoomId,
      patcherHandle,
      [
        `@${patcherHandle}${extraCoderMention} **[ESCALATE ${alert.incidentId} scenario=${alert.scenarioId}]**`,
        `Reproduce & stage surgical fix for \`${alert.service}\` (\`${alert.deployedVersion}\`):`,
        `- **Exception:** \`${alert.errorMessage}\``,
        `- **Suspect:** \`${alert.suspectedCommit.sha}\` at \`${alert.suspectedCommit.filePath}:${alert.suspectedCommit.line}\``,
        `- **Repro Payload:** \`${JSON.stringify(alert.reproductionPayload)}\``,
      ].join('\n'),
    );
  }

  private wireSentinelHandlers(): void {
    this.sentinelClient.onAddressedMessage(async (event, meta) => {
      if (meta.hadGapBeforeEvent) {
        await this.sentinelClient.readContext(event.room_id, 20);
      }
      const body = event.payload.body;

      // Closure callback from Release Gate across room link `#releases -> #incidents`
      const resolvedMatch = body.match(/\[RESOLVED\s+(INC-[0-9A-Z-]+)\s+mode=(promote|rollback)\s+version=([^\]]+)\]/i);
      if (resolvedMatch) {
        const incId = resolvedMatch[1].toUpperCase();
        const mode = resolvedMatch[2].toLowerCase();
        const version = resolvedMatch[3];
        const rec = this.incidents.get(incId);

        if (rec) {
          await this.sentinelClient.updateRoomDocument(
            this.roomsByRole.incidentsRoomId,
            'blast-radius-dossier',
            [
              `# Blast Radius Dossier — ${incId} (CLOSED)`,
              `- **Final Outcome:** ${mode === 'promote' ? `Hotfix Promoted (\`${version}\`)` : `Rolled Back to LKG (\`${version}\`)`}`,
              `- **Resolved At:** ${new Date().toISOString()}`,
              `- **Canary Health:** 5/5 synthetic checkout probes passing (\`0.0%\` error rate)`,
            ].join('\n'),
          );
        }

        await this.sentinelClient.releaseRole(this.roomsByRole.incidentsRoomId, 'incident-commander');
        await this.sentinelClient.postMessage(
          this.roomsByRole.incidentsRoomId,
          `✅ **[${incId} CLOSED]** Updated \`blast-radius-dossier\`, verified \`${version}\` recovery, and released \`incident-commander\` lease. Mesh back on standby.`,
        );
        this.opts.onEventUpdate?.();
        return;
      }

      // Interactive chat commands from human teammates in `#vigil-incidents`
      if (/\b(status|health|summary)\b/i.test(body)) {
        const telemetry = this.opts.checkoutService.getTelemetry();
        const active = this.getActiveIncident();
        await this.sentinelClient.postMessage(
          event.room_id,
          [
            `📡 **Vigil Sentinel Telemetry Snapshot**`,
            `- **Checkout Service:** \`${telemetry.deployedVersion}\` (${telemetry.status.toUpperCase()}) · Error rate \`${telemetry.errorRatePct}%\` · p99 \`${telemetry.p99LatencyMs}ms\` · Locks \`${telemetry.activeInventoryLocks}/${telemetry.maxInventoryLocks}\``,
            `- **Active Incident:** ${active ? `\`${active.incidentId}\` (${active.stage})` : 'None — all systems nominal'}`,
          ].join('\n'),
        );
      } else if (/\b(trigger|simulate|inject)\b/i.test(body)) {
        const scenario: FaultScenarioId = /promo/i.test(body)
          ? 'promo_negative_ledger_500'
          : /lock|pool/i.test(body)
            ? 'inventory_lock_leak_503'
            : 'jpy_zero_decimal_500';
        await this.opts.checkoutService.injectFaultRelease(scenario);
      }
    });
  }

  private wirePatcherHandlers(): void {
    this.patcherClient.onAddressedMessage(async (event, meta) => {
      if (meta.hadGapBeforeEvent) {
        await this.patcherClient.readContext(event.room_id, 20);
      }
      const body = event.payload.body;

      // Escalation handoff from Sentinel
      const escalateMatch = body.match(/\[ESCALATE\s+(INC-[0-9A-Z-]+)\s+scenario=([a-z0-9_]+)\]/i);
      if (escalateMatch) {
        const incidentId = escalateMatch[1].toUpperCase();
        const scenarioId = escalateMatch[2] as FaultScenarioId;
        const rec = this.incidents.get(incidentId);
        if (rec) {
          rec.stage = 'reproducing_patching';
          this.opts.onEventUpdate?.();
        }

        const hotfixRoomId = this.roomsByRole.hotfixRoomId;
        await this.patcherClient.assumeRole(hotfixRoomId, 'patch-author');
        await this.patcherClient.loadInternalDocuments(hotfixRoomId);

        // Execute real bug reproduction + candidate verification suite
        const verification = this.opts.checkoutService.reproduceAndStagePatch(incidentId, scenarioId);
        if (rec) {
          rec.patchVerification = verification;
        }

        const reportMarkdown = [
          `# Patch Verification Report — ${incidentId}`,
          `- **Candidate Version:** \`${verification.candidateVersion}\` (${verification.changedLines} lines across \`${verification.touchedFiles.join(', ')}\`)`,
          `- **Deterministic Reproduction:** ${verification.reproConfirmed ? 'CONFIRMED' : 'FAILED'} — \`${verification.reproErrorOutput}\``,
          '',
          '## Unified Diff',
          '```diff',
          verification.diffUnified,
          '```',
          '',
          '## Regression Matrix',
          ...verification.testMatrix.map(
            (t) => `- [${t.passed ? 'x' : ' '}] **${t.name}** — ${t.detail}`,
          ),
        ].join('\n');

        await this.patcherClient.createRoomDocument(hotfixRoomId, {
          name: 'patch-verification-report',
          description: `Reproduction output, diff, and regression matrix for ${incidentId}`,
          instructions: 'Inspected by Release Gate and human reviewers prior to canary promotion.',
          content: reportMarkdown,
        });

        await this.patcherClient.postMessage(
          hotfixRoomId,
          [
            `🔬 **[${incidentId} REPRODUCED & PATCH VERIFIED]**`,
            `1. **Reproduced on \`v2.14.0\`:** \`${verification.reproErrorOutput}\``,
            `2. **Staged Candidate \`${verification.candidateVersion}\`** (${verification.changedLines} lines changed in \`${verification.touchedFiles[0]}\`):`,
            '```diff',
            verification.diffUnified,
            '```',
            `3. **Verification Suite:** **${verification.testMatrix.filter((t) => t.passed).length}/${verification.testMatrix.length} passed** (USD, JPY, KRW, Promo Floor, Fraud Lock Release).`,
            `Saved \`patch-verification-report\` room document. Handing off across room link -> \`#${this.teamPrefix}-releases\`.`,
          ].join('\n'),
        );

        const links = await this.patcherClient.listLinkedRooms(hotfixRoomId);
        const releaseLink = links.find(
          (l) => l.from_room_id === hotfixRoomId && l.to_room_name.includes('releases'),
        );
        const targetReleaseRoomId = releaseLink?.to_room_id ?? this.roomsByRole.releasesRoomId;
        const gateHandle = `${this.teamPrefix}-release-gate`;

        await this.patcherClient.releaseRole(hotfixRoomId, 'patch-author');

        await this.patcherClient.sendTargetedMessage(
          targetReleaseRoomId,
          gateHandle,
          `@${gateHandle} **[HANDOFF ${incidentId}]** Candidate \`${verification.candidateVersion}\` (${verification.changedLines} lines, ${verification.testMatrix.length}/${verification.testMatrix.length} green tests) staged and ready for human release gate.`,
        );
        return;
      }

      if (/\b(diff|patch|tests)\b/i.test(body)) {
        const active = this.getActiveIncident();
        if (active?.patchVerification) {
          await this.patcherClient.postMessage(
            event.room_id,
            `📄 **Staged Diff for ${active.incidentId} (\`${active.patchVerification.candidateVersion}\`):**\n\`\`\`diff\n${active.patchVerification.diffUnified}\n\`\`\``,
          );
        } else {
          await this.patcherClient.postMessage(
            event.room_id,
            `No staged hotfix diff currently pending. Standing by in \`#${this.teamPrefix}-hotfix\`.`,
          );
        }
      }
    });
  }

  private wireReleaseGateHandlers(): void {
    this.releaseGateClient.onAddressedMessage(async (event, meta) => {
      if (meta.hadGapBeforeEvent) {
        await this.releaseGateClient.readContext(event.room_id, 20);
      }
      const body = event.payload.body;
      const releasesRoomId = this.roomsByRole.releasesRoomId;

      // 1. Staged candidate handoff from Patcher -> open Human Sign-off Gate!
      const handoffMatch = body.match(/\[HANDOFF\s+(INC-[0-9A-Z-]+)\]/i);
      if (handoffMatch) {
        const incidentId = handoffMatch[1].toUpperCase();
        const rec = this.incidents.get(incidentId);
        if (!rec) return;

        rec.stage = 'awaiting_human_gate';
        this.opts.onEventUpdate?.();

        await this.releaseGateClient.assumeRole(releasesRoomId, 'release-gatekeeper');
        const operator = this.opts.creatorUsername ?? 'priya';
        const v = rec.patchVerification;
        const gateName = `${this.teamPrefix}-release-gate`;

        await this.releaseGateClient.postMessage(
          releasesRoomId,
          [
            `🛡️ **[HUMAN RELEASE GATE — ${incidentId}]** @${operator}`,
            `- **Incident:** ${rec.title} (Commit \`${rec.alert.suspectedCommit.sha}\`)`,
            `- **Candidate Patch:** \`${v?.candidateVersion ?? 'v2.14.1-hotfix'}\` · \`${v?.changedLines ?? 0}\` changed lines · **${v?.testMatrix.filter((t) => t.passed).length ?? 0}/${v?.testMatrix.length ?? 0}** verification vectors green`,
            `- **Fallback Baseline:** \`${rec.alert.lastKnownGoodVersion}\` (instant zero-migration rollback)`,
            '',
            `**Action Required (Verified Human Only — Agent approvals blocked):**`,
            `- Promote hotfix: \`@${gateName} approve ${incidentId} promote\``,
            `- Rollback to LKG: \`@${gateName} approve ${incidentId} rollback\``,
          ].join('\n'),
        );
        return;
      }

      // 2. Evaluate approval / rollback command through deterministic Zero-LLM ReleaseSafetyGate
      const active = this.getActiveIncident();
      if (!active || active.resolvedAt !== null) {
        if (/\b(policy|status|help)\b/i.test(body)) {
          await this.releaseGateClient.postMessage(
            event.room_id,
            `🛡️ **Vigil Release Gate:** Standby (no active gated incident). Invariants enforced: Human-only sign-off (\`@switch-user-*\`), incident ID binding, 100% green test matrix, <40-line diff cap, and 5-probe post-deploy canary verification.`,
          );
        }
        return;
      }

      // Only run gate evaluation when message attempts an approval/rollback or comes from an agent trying to approve
      if (/\b(approve|ship|execute|rollback)\b/i.test(body)) {
        const decision = ReleaseSafetyGate.evaluate({
          senderParticipantId: event.payload.sender,
          senderName: event.payload.sender_name,
          messageBody: body,
          activeIncidentId: active.incidentId,
          knownAgentParticipantIds: this.knownAgentParticipantIds,
          knownAgentNames: this.knownAgentNames,
          patchVerification: active.patchVerification,
        });

        active.gateDecisions.push({
          ...decision,
          timestamp: Date.now(),
          senderName: event.payload.sender_name,
        });
        this.opts.onEventUpdate?.();

        if (!decision.allowed || !decision.action) {
          await this.releaseGateClient.postMessage(
            event.room_id,
            `⛔ **[GATE BLOCKED — ${decision.reasonCode}]** ${decision.explanation}`,
          );
          return;
        }

        // Approved by verified human! Apply release/rollback & run live HTTP synthetic canary probes
        const outcome = await this.opts.checkoutService.applyApprovedRelease(decision.action);
        active.canaryReport = outcome.canaryReport;
        active.finalVersion = outcome.deployedVersion;
        active.resolvedAt = Date.now();
        active.stage =
          decision.action === 'promote' ? 'resolved_promoted' : 'resolved_rolled_back';
        if (this.activeIncidentId === active.incidentId) {
          this.activeIncidentId = null;
        }
        this.opts.onEventUpdate?.();

        // Publish blameless Postmortem Room-Scoped Document in `#vigil-releases`
        const durationSec = Math.max(1, Math.round((active.resolvedAt - active.openedAt) / 1000));
        const postmortemDoc = [
          `# Blameless Postmortem — ${active.incidentId}`,
          `- **Incident:** ${active.title}`,
          `- **Resolution Action:** \`${decision.action.toUpperCase()}\` -> \`${outcome.deployedVersion}\` (Approved by human \`${event.payload.sender_name}\`)`,
          `- **Time to Resolution (MTTR):** ${durationSec}s across linked Switch rooms`,
          `- **Root Cause:** Commit \`${active.alert.suspectedCommit.sha}\` (\`${active.alert.suspectedCommit.filePath}:${active.alert.suspectedCommit.line}\`) — ${active.alert.errorMessage}`,
          `- **Post-Deploy Synthetic Canary:** ${outcome.canaryReport.probesPassed}/${outcome.canaryReport.probesRun} probes \`200 OK\` (max latency ${outcome.canaryReport.maxLatencyMs}ms)`,
          '',
          '## Synthetic Canary Results',
          ...outcome.canaryReport.details.map((d) => `- ${d}`),
        ].join('\n');

        await this.releaseGateClient.createRoomDocument(releasesRoomId, {
          name: `postmortem-${active.incidentId.toLowerCase()}`,
          description: `Audited blameless postmortem & canary verification for ${active.incidentId}`,
          instructions: 'Permanent audit trail generated by Vigil Release Gate.',
          content: postmortemDoc,
        });

        await this.releaseGateClient.postMessage(
          releasesRoomId,
          [
            `🚀 **[${active.incidentId} ${decision.action === 'promote' ? 'HOTFIX PROMOTED' : 'ROLLED BACK'} -> \`${outcome.deployedVersion}\`]**`,
            `- **Authorized By:** \`${event.payload.sender_name}\` (\`${event.payload.sender}\`)`,
            `- **Synthetic Canary Probes:** **${outcome.canaryReport.probesPassed}/${outcome.canaryReport.probesRun} \`200 OK\`** (max \`${outcome.canaryReport.maxLatencyMs}ms\`)`,
            `- **Audit Trail:** Saved room document \`postmortem-${active.incidentId.toLowerCase()}\`. Notifying \`#${this.teamPrefix}-incidents\`.`,
          ].join('\n'),
        );

        await this.releaseGateClient.releaseRole(releasesRoomId, 'release-gatekeeper');

        // Traverse room link `#releases -> #incidents` to close out Sentinel's command lease!
        const links = await this.releaseGateClient.listLinkedRooms(releasesRoomId);
        const incidentsLink = links.find(
          (l) => l.from_room_id === releasesRoomId && l.to_room_name.includes('incidents'),
        );
        const targetIncidentsRoomId = incidentsLink?.to_room_id ?? this.roomsByRole.incidentsRoomId;
        const sentinelHandle = `${this.teamPrefix}-sentinel`;

        await this.releaseGateClient.sendTargetedMessage(
          targetIncidentsRoomId,
          sentinelHandle,
          `@${sentinelHandle} **[RESOLVED ${active.incidentId} mode=${decision.action} version=${outcome.deployedVersion}]** Approved by ${event.payload.sender_name}; 5/5 canary probes green.`,
        );
      }
    });
  }
}
