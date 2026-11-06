import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
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
} from '../services/checkoutTarget.js';
import {
  DEFAULT_RELEASE_POLICY,
  ReleaseGateDecision,
  ReleasePolicy,
  ReleaseSafetyGate,
} from '../gate/releaseSafetyGate.js';
import YAML from 'yaml';

export type PatchMode = 'auto' | 'external';

export interface SentinelFailoverRecord {
  at: number;
  trigger: 'chaos_hang';
  previousGeneration: number | null;
  newGeneration: number | null;
  resumedFromCursor: number;
  leaseReclaimed: boolean;
  previousConnectionEvicted: boolean;
}

export interface PolicyAuditEntry {
  at: number;
  senderName: string;
  senderParticipantId: string;
  accepted: boolean;
  summary: string;
}

export type IncidentLifecycleStage =
  | 'detecting'
  | 'triaged_escalated'
  | 'reproducing_patching'
  | 'awaiting_human_gate'
  | 'resolved_promoted'
  | 'resolved_rolled_back'
  /** Still open when Vigil restarted: the target was rebuilt from the last known good release. */
  | 'interrupted';

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
  /** Ephemeral per-incident red/blue workroom created from `vigil-hotfix-workroom.template.yaml`. */
  workroom: { roomId: string; roomName: string; archived: boolean } | null;
  /** Which patcher the incident was routed to. */
  patchMode: PatchMode;
}

export interface VigilMeshOptions {
  switchServerUrl: string;
  registrationKey: string;
  teamPrefix?: string;
  bridgeName?: string;
  creatorUsername?: string;
  externalCoderHandle?: string;
  /** `auto`: Vigil's patcher writes the fix. `external`: a coding agent bound via Switch Console (e.g. Claude Code) does; Vigil verifies. */
  patchMode?: PatchMode;
  checkoutService: CheckoutMicroservice;
  /**
   * Keep the incident ledger and the policy audit in this JSON file across restarts. Incidents still
   * open at startup are marked `interrupted`, because the target restarts from the last known good
   * release and their regression is gone.
   */
  ledgerFile?: string;
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

  private patchMode: PatchMode;
  private releasePolicy: ReleasePolicy = DEFAULT_RELEASE_POLICY;
  private readonly policyAudit: PolicyAuditEntry[] = [];
  private readonly failovers: SentinelFailoverRecord[] = [];
  private sentinelCreds: { id: string; api_key: string } | null = null;
  private recordTrace: (trace: ProtocolWireTrace) => void = () => {};
  private retiredSentinels: SwitchAgentClient[] = [];

  constructor(opts: VigilMeshOptions) {
    // Every state change already notifies; saving the ledger rides on the same signal.
    const notify = opts.onEventUpdate;
    this.opts = {
      ...opts,
      onEventUpdate: () => {
        notify?.();
        this.schedulePersist();
      },
    };
    this.teamPrefix = opts.teamPrefix ?? 'vigil';
    this.patchMode = opts.patchMode ?? (opts.externalCoderHandle ? 'external' : 'auto');
    this.loadLedger();
  }

  private persistTimer: NodeJS.Timeout | null = null;

  private loadLedger(): void {
    const file = this.opts.ledgerFile;
    if (!file || !existsSync(file)) return;
    const saved = JSON.parse(readFileSync(file, 'utf8')) as {
      incidents?: IncidentLedgerRecord[];
      policyAudit?: PolicyAuditEntry[];
    };
    let lastNumber = 0;
    for (const record of saved.incidents ?? []) {
      if (!record.stage.startsWith('resolved') && record.stage !== 'interrupted') {
        record.stage = 'interrupted';
        record.resolvedAt = Date.now();
      }
      this.incidents.set(record.incidentId, record);
      lastNumber = Math.max(lastNumber, Number(/^INC-(\d+)$/.exec(record.incidentId)?.[1] ?? 0));
    }
    this.policyAudit.push(...(saved.policyAudit ?? []));
    if (lastNumber > 0) this.opts.checkoutService.seedIncidentSequence(lastNumber);
  }

  /** Write the ledger at most every 300 ms, atomically (temp file, then rename). */
  private schedulePersist(): void {
    const file = this.opts.ledgerFile;
    if (!file || this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      try {
        mkdirSync(path.dirname(file), { recursive: true });
        const tmp = `${file}.tmp`;
        const incidents = this.getIncidents().slice(0, 200);
        writeFileSync(tmp, JSON.stringify({ savedAt: Date.now(), incidents, policyAudit: this.policyAudit.slice(-500) }));
        renameSync(tmp, file);
      } catch (err) {
        console.error('[vigil] could not save the incident ledger:', (err as Error).message);
      }
    }, 300);
  }

  public getPatchMode(): PatchMode {
    return this.patchMode;
  }

  public setPatchMode(mode: PatchMode): void {
    this.patchMode = mode;
    this.opts.onEventUpdate?.();
  }

  public getExternalCoderHandle(): string {
    return this.opts.externalCoderHandle ?? 'claude-code';
  }

  public getReleasePolicy(): ReleasePolicy {
    return this.releasePolicy;
  }

  public getPolicyAudit(): PolicyAuditEntry[] {
    return [...this.policyAudit];
  }

  public getFailovers(): SentinelFailoverRecord[] {
    return [...this.failovers];
  }

  public getRetiredSentinels(): Array<{ connectionId: string; generation: number | null; evicted: boolean; hung: boolean }> {
    return this.retiredSentinels.map((c) => ({
      connectionId: c.connectionId,
      generation: c.getGeneration() ?? null,
      evicted: c.isStoppedPermanently(),
      hung: c.isHung(),
    }));
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
        description: 'Watches checkout-api, opens incidents and leads them',
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
        description: 'Reproduces the bug, fixes or checks the fix, runs the tests',
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
        description: 'Ships or rolls back only when a person approves',
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

    this.sentinelCreds = sentinelCreds;

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

    // 2. Embedded server: provision the 3-room linked group from `templates/vigil-war-room.template.yaml`
    //    over its HTTP template endpoint before anyone connects. (A real Switch server is provisioned
    //    through the `create_room_from_yaml` operation below, once the agents hold open connections.)
    if (this.opts.provisionTemplateViaApi) {
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
    this.recordTrace = recordTrace;

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

    // 4. Open live WebSockets and receive `connection_state`. A real Switch server only accepts
    //    operations from a caller with an open connection, so everything below runs after this.
    await Promise.all([
      this.sentinelClient.connect(),
      this.patcherClient.connect(),
      this.releaseGateClient.connect(),
    ]);

    // 5. A newly registered Switch agent answers only its owner. The mesh needs agent-to-agent handoffs
    //    and approvals from any human teammate, so widen addressing to `anyone`.
    if (this.sentinelClient.isSwitchCore()) {
      // switch-core refuses an agent changing its own setting but lets it change a sibling agent with
      // the same owner, so the sentinel opens up the patcher and gate, and the patcher the sentinel.
      const widen: Array<[SwitchAgentClient, string, string]> = [
        [this.sentinelClient, patcherCreds.id, patcherName],
        [this.sentinelClient, gateCreds.id, gateName],
        [this.patcherClient, sentinelCreds.id, sentinelName],
      ];
      await Promise.all(
        widen.map(([client, targetId, targetName]) =>
          client.updateAddressing('anyone', targetId).catch((err: Error) => {
            console.warn(`[vigil] could not set addressing=anyone on ${targetName}: ${err.message}`);
          }),
        ),
      );
    } else {
      await Promise.all(
        [this.sentinelClient, this.patcherClient, this.releaseGateClient].map((c) =>
          c.updateAddressing('anyone').catch(() => undefined),
        ),
      );
    }

    // 6. Resolve room IDs. On a real Switch server, create the rooms from the template the first time.
    let mergedRooms = await this.collectRooms();
    const expected = ['incidents', 'hotfix', 'releases'].map((r) => `${this.teamPrefix}-${r}`);
    if (expected.some((name) => !mergedRooms.has(name)) && this.sentinelClient.isSwitchCore()) {
      await this.provisionRoomsOnSwitchCore(templateYamlPath);
      mergedRooms = await this.collectRooms();
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

    // A live server keeps rooms across Vigil restarts: number new incidents after the last workroom.
    if (this.sentinelClient.isSwitchCore()) {
      const all = await this.sentinelClient.listRooms(true).catch(() => []);
      const used = all
        .map((r) => /^hotfix-inc-(\d+)/i.exec(r.name)?.[1])
        .filter((n): n is string => Boolean(n))
        .map(Number);
      if (used.length > 0) this.opts.checkoutService.seedIncidentSequence(Math.max(...used));
    }

    // On a real server only a document's creator may edit it, so the gate must own its policy.
    if (this.releaseGateClient.isSwitchCore()) await this.ensureGateOwnsPolicyDocument();

    // 7. Rooms are known: start handling room traffic.
    this.wireSentinelHandlers();
    this.wirePatcherHandlers();
    this.wireReleaseGateHandlers();

    // Subscribe checkout-api incident alerts directly to Sentinel
    this.opts.checkoutService.setIncidentWebhook(async (alert) => {
      await this.handleIncomingTelemetryAlert(alert);
    });
  }

  /**
   * switch-core lets only the agent that created a room document edit it. The release gate rewrites
   * `release-safety-policy` whenever a person changes the policy from chat, so it creates the document
   * itself. A copy someone else created (an older template) cannot be edited by the gate: an admin
   * deletes it, and the gate recreates it on the next start.
   */
  private async ensureGateOwnsPolicyDocument(): Promise<void> {
    const roomId = this.roomsByRole.releasesRoomId;
    const detail = (await this.releaseGateClient.connectToRoom(roomId)) as unknown as {
      documents?: Array<{ name: string; created_by_agent_id?: string | null }>;
    };
    const doc = (detail.documents ?? []).find((d) => d.name === 'release-safety-policy');
    if (!doc) {
      await this.releaseGateClient.createRoomDocument(roomId, {
        name: 'release-safety-policy',
        description: 'The rules the release gate checks before shipping',
        instructions: 'Read on every approval. People change it from chat; agents cannot.',
        content: ReleaseSafetyGate.renderPolicyDocument(DEFAULT_RELEASE_POLICY, undefined, this.teamPrefix),
      });
      return;
    }
    if (doc.created_by_agent_id !== this.releaseGateClient.agentId) {
      console.warn(
        `[vigil] release-safety-policy in #${this.teamPrefix}-releases was not created by ${this.releaseGateClient.agentName}, ` +
          'so policy changes from chat cannot be saved. Delete it as an admin; Vigil recreates it on the next start.',
      );
    }
  }

  /** Rooms the sentinel or patcher is assigned to, by name. */
  private async collectRooms(): Promise<Map<string, SwitchRoomDetail>> {
    const rooms = await this.sentinelClient.listRooms();
    const allPatcherRooms = await this.patcherClient.listRooms();
    const merged = new Map<string, SwitchRoomDetail>();
    for (const r of [...rooms, ...allPatcherRooms]) {
      merged.set(r.name, r);
    }
    return merged;
  }

  /**
   * First run against a real Switch server: create `#{team}-incidents`, `#{team}-hotfix` and
   * `#{team}-releases` (roles, documents, references, links) from the war-room template. The
   * template's `agents:` block asks Switch Console to start managed coding agents; Vigil's agents
   * already exist as live WebSocket agents, so that block is dropped and the rooms name them.
   */
  private async provisionRoomsOnSwitchCore(templateYamlPath?: string): Promise<void> {
    const resolvedPath =
      templateYamlPath ?? path.resolve(process.cwd(), 'templates/vigil-war-room.template.yaml');
    const doc = YAML.parse(readFileSync(resolvedPath, 'utf8')) as {
      agents?: unknown;
      params?: Record<string, unknown>;
    };
    delete doc.agents;
    for (const key of ['provider', 'location', 'directory']) delete doc.params?.[key];
    // The release gate creates its own policy document after provisioning, so it can edit it later.
    for (const room of (doc as { rooms?: Array<{ docs?: Array<{ name: string }> }> }).rooms ?? []) {
      if (room.docs) room.docs = room.docs.filter((d) => d.name !== 'release-safety-policy');
    }
    await this.sentinelClient.createRoomsFromYaml(YAML.stringify(doc), {
      team: this.teamPrefix,
      bridge: this.opts.bridgeName ?? 'Mattermost',
    });
  }

  public async shutdown(): Promise<void> {
    await Promise.all([
      ...this.retiredSentinels.map((c) => c.disconnect().catch(() => undefined)),
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
      workroom: null,
      patchMode: this.patchMode,
    };
    this.incidents.set(alert.incidentId, record);
    this.activeIncidentId = alert.incidentId;
    this.opts.onEventUpdate?.();

    const incRoomId = this.roomsByRole.incidentsRoomId;

    // 1. Claim exclusive `incident-commander` role lease in `#vigil-incidents`
    await this.sentinelClient.assumeRole(incRoomId, 'incident-commander');

    // 2. Write `blast-radius-dossier` Room-Scoped Document
    const dossierMarkdown = [
      `# ${alert.incidentId}: what broke`,
      `- **Status:** open, handed to #${this.teamPrefix}-hotfix`,
      `- **Service:** ${alert.service} \`${alert.deployedVersion}\` (last good: \`${alert.lastKnownGoodVersion}\`)`,
      `- **Endpoint:** \`${alert.endpoint}\` ${alert.httpStatus ? `returns HTTP ${alert.httpStatus}` : 'is failing'} (${alert.errorRatePct}% errors, p99 ${alert.p99LatencyMs} ms, measured by the service)`,
      `- **Suspect commit:** \`${alert.suspectedCommit.sha}\` by \`${alert.suspectedCommit.author}\`: ${alert.suspectedCommit.message} (\`${alert.suspectedCommit.filePath}:${alert.suspectedCommit.line}\`)`,
      `- **Stack trace:**`,
      '```',
      alert.stackTrace.split('\n').slice(0, 6).join('\n'),
      '```',
      `- **Error:** \`${alert.errorMessage}\``,
      `- **Failing request:** \`${JSON.stringify(alert.reproductionPayload)}\``,
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
        `**${alert.incidentId}, SEV-1: ${spec.title}**`,
        `- \`${alert.endpoint}\` ${alert.httpStatus ? `returns HTTP ${alert.httpStatus}` : 'is failing'} on \`${alert.deployedVersion}\`: ${alert.errorRatePct}% errors, p99 ${alert.p99LatencyMs} ms.`,
        `- Suspect commit \`${alert.suspectedCommit.sha}\` at \`${alert.suspectedCommit.filePath}:${alert.suspectedCommit.line}\`: ${alert.suspectedCommit.message}.`,
        `- I hold \`incident-commander\` and wrote \`blast-radius-dossier\`. Escalating to #${this.teamPrefix}-hotfix.`,
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
    const coder = this.getExternalCoderHandle();
    const external = record.patchMode === 'external';

    // Ephemeral per-incident red/blue workroom, instantiated from the hotfix workroom template
    await this.openIncidentWorkroom(record, targetHotfixRoomId).catch((err) => {
      this.recordTrace({
        id: `trace_workroom_${Date.now()}`,
        timestamp: Date.now(),
        agentId: this.sentinelClient.agentId,
        agentName: this.sentinelClient.agentName,
        direction: 'http_op',
        frameType: 'op:create_room',
        summary: `Workroom creation skipped: ${(err as Error).message.slice(0, 120)}`,
        payload: {},
      });
    });

    await this.sentinelClient.sendTargetedMessage(
      targetHotfixRoomId,
      patcherHandle,
      [
        `@${patcherHandle}${external ? ` @${coder}` : ''} **[ESCALATE ${alert.incidentId} scenario=${alert.scenarioId} mode=${record.patchMode}]**`,
        external
          ? `@${coder}: you hold \`patch-author\` for this incident. Reproduce with the payload below against \`${this.opts.checkoutService.getBaseUrl()}/api/checkout\`, then fix it in the live working copy \`${this.opts.checkoutService.getWorkDir()}\` (HEAD is the regression commit). Hand off either by editing the files there and posting \`@${patcherHandle} verify ${alert.incidentId}\`, or by posting your unified diff in a \`\`\`diff block addressed to @${patcherHandle} (or \`POST /api/incidents/${alert.incidentId}/stage-patch\`). @${patcherHandle} verifies with the real test suite as \`red-team-verifier\`.`
          : `Reproduce and fix \`${alert.service}\` (\`${alert.deployedVersion}\`):`,
        `- **Exception:** \`${alert.errorMessage}\``,
        `- **Suspect:** \`${alert.suspectedCommit.sha}\` at \`${alert.suspectedCommit.filePath}:${alert.suspectedCommit.line}\``,
        `- **Failing request:** \`${JSON.stringify(alert.reproductionPayload)}\`${spec.reproAttempts > 1 ? ` (send it up to ${spec.reproAttempts} times; the fault needs repeated requests to show)` : ''}`,
        record.workroom ? `- **Workroom:** \`#${record.workroom.roomName}\` (linked from \`#${this.teamPrefix}-hotfix\`)` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }

  /**
   * Rooms as lifecycle objects: the sentinel instantiates `templates/vigil-hotfix-workroom.template.yaml`
   * for each incident via `create_room`, links it from `#{team}-hotfix` via `link_rooms`, posts the
   * template kickoff, and archives it via `archive_room` at closure.
   */
  private async openIncidentWorkroom(record: IncidentLedgerRecord, hotfixRoomId: string): Promise<void> {
    const templatePath = path.resolve(process.cwd(), 'templates/vigil-hotfix-workroom.template.yaml');
    const raw = YAML.parse(readFileSync(templatePath, 'utf8')) as {
      room: Record<string, unknown>;
      kickoff?: string;
    };
    const patcher = `${this.teamPrefix}-patcher`;
    const gate = `${this.teamPrefix}-release-gate`;
    const params: Record<string, string> = {
      incident_id: record.incidentId,
      patcher_agent: record.patchMode === 'external' ? this.getExternalCoderHandle() : patcher,
      gate_agent: gate,
      bridge: this.opts.bridgeName ?? 'Mattermost',
      stack_trace: `${record.alert.errorMessage}\nSuspect commit ${record.alert.suspectedCommit.sha} (${record.alert.suspectedCommit.filePath}:${record.alert.suspectedCommit.line})`,
      $creator: this.opts.creatorUsername ?? 'priya',
    };
    const fill = (v: unknown): string =>
      String(v ?? '').replace(/\{(\$?[a-zA-Z0-9_-]+)\}/g, (m, k: string) => params[k] ?? m);

    const room = raw.room;
    const roles = Array.isArray(room.roles)
      ? (room.roles as Array<Record<string, unknown>>).map((r) => ({
          name: fill(r.name),
          instructions: fill(r.instructions),
          exclusive: Boolean(r.exclusive),
        }))
      : [];

    if (this.sentinelClient.isSwitchCore()) {
      const inputs: Record<string, string> = { ...params };
      delete inputs.$creator;
      const [room] = await this.sentinelClient.createRoomsFromYaml(readFileSync(templatePath, 'utf8'), inputs);
      if (!room) throw new Error(`create_room_from_yaml returned no room for ${record.incidentId}`);
      // The template seats the patcher and the gate. The sentinel joins too, so it can close the room.
      await this.sentinelClient.inviteAgentToRoom(room.id, this.sentinelClient.agentName);
      await this.sentinelClient.linkRooms(hotfixRoomId, room.id, `per-incident red/blue workroom for ${record.incidentId}`);
      record.workroom = { roomId: room.id, roomName: room.name, archived: false };
      this.opts.onEventUpdate?.();
      return;
    }

    const created = await this.sentinelClient.createRoom({
      name: fill(room.name).toLowerCase(),
      description: fill(room.description),
      instructions: fill(room.instructions),
      bridge: params.bridge,
      channel_type: room.channel_type === 'channel_private' ? 'channel_private' : 'channel_public',
      agents: [patcher, gate, this.sentinelClient.agentName],
      users: [params.$creator],
      roles,
    });

    await this.sentinelClient.linkRooms(hotfixRoomId, created.id, `per-incident red/blue workroom for ${record.incidentId}`);
    record.workroom = { roomId: created.id, roomName: created.name, archived: false };
    this.opts.onEventUpdate?.();

    if (raw.kickoff) {
      await this.sentinelClient.postMessage(created.id, fill(raw.kickoff).trim());
    }
  }

  private async archiveIncidentWorkroom(record: IncidentLedgerRecord, outcome: string): Promise<void> {
    if (!record.workroom || record.workroom.archived) return;
    await this.sentinelClient.postMessage(
      record.workroom.roomId,
      `**${record.incidentId} closed (${outcome}).** Archiving this room. The verification report stays in #${this.teamPrefix}-hotfix and the postmortem in #${this.teamPrefix}-releases.`,
    ).catch(() => undefined);
    await this.sentinelClient.archiveRoom(record.workroom.roomId);
    record.workroom.archived = true;
    this.opts.onEventUpdate?.();
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

        const canary = rec?.canaryReport;
        const canaryLine = canary
          ? `${canary.probesPassed} of ${canary.probesRun} canary probes passed`
          : 'no canary report';
        if (rec) {
          // Keep the investigation: append the closure to the dossier rather than replacing it.
          const docs = await this.sentinelClient.loadInternalDocuments(this.roomsByRole.incidentsRoomId).catch(() => []);
          const current = docs.find((d) => d.name === 'blast-radius-dossier')?.content ?? `# ${incId}`;
          await this.sentinelClient.updateRoomDocument(
            this.roomsByRole.incidentsRoomId,
            'blast-radius-dossier',
            [
              current.replace(/\n## Closed[\s\S]*$/, '').trimEnd(),
              '',
              '## Closed',
              `- **Outcome:** ${mode === 'promote' ? `fix shipped as \`${version}\`` : `rolled back to \`${version}\``}`,
              `- **Closed at:** ${new Date().toISOString()}`,
              `- **After the deploy:** ${canaryLine}`,
            ].join('\n'),
          );
        }

        if (rec) {
          await this.archiveIncidentWorkroom(rec, mode === 'promote' ? `promoted ${version}` : `rolled back to ${version}`).catch(() => undefined);
        }

        await this.sentinelClient.releaseRole(this.roomsByRole.incidentsRoomId, 'incident-commander');
        await this.sentinelClient.postMessage(
          this.roomsByRole.incidentsRoomId,
          `**${incId} closed.** \`${version}\` is live; ${canaryLine}. I updated \`blast-radius-dossier\`${rec?.workroom ? `, archived #${rec.workroom.roomName}` : ''} and released \`incident-commander\`.`,
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
            `**Status**`,
            `- checkout-api \`${telemetry.deployedVersion}\`: ${telemetry.status}, ${telemetry.errorRatePct}% errors, p99 ${telemetry.p99LatencyMs} ms, ${telemetry.activeInventoryLocks} of ${telemetry.maxInventoryLocks} inventory locks held`,
            `- Open incident: ${active ? `${active.incidentId} (${active.stage.replace(/_/g, ' ')})` : 'none'}`,
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
      const escalateMatch = body.match(/\[ESCALATE\s+(INC-[0-9A-Z-]+)\s+scenario=([a-z0-9_]+)(?:\s+mode=(auto|external))?\]/i);
      if (escalateMatch) {
        const incidentId = escalateMatch[1].toUpperCase();
        const scenarioId = escalateMatch[2] as FaultScenarioId;
        const mode = (escalateMatch[3]?.toLowerCase() as PatchMode | undefined) ?? this.patchMode;
        const rec = this.incidents.get(incidentId);
        if (rec) {
          rec.stage = 'reproducing_patching';
          rec.patchMode = mode;
          this.opts.onEventUpdate?.();
        }

        const hotfixRoomId = this.roomsByRole.hotfixRoomId;
        await this.patcherClient.loadInternalDocuments(hotfixRoomId);

        if (mode === 'external') {
          // External coding agent authors the fix; Vigil's patcher takes the verifier seat.
          await this.patcherClient.assumeRole(hotfixRoomId, 'red-team-verifier');
          const coder = this.getExternalCoderHandle();
          const alert = rec?.alert;
          await this.patcherClient.postMessage(
            hotfixRoomId,
            [
              `**${incidentId}: waiting for @${coder}.** \`patch-author\` is theirs; I hold \`red-team-verifier\` and will check their change.`,
              alert ? `The alert on \`${alert.deployedVersion}\` reports \`${alert.errorMessage}\`; I reproduce it myself when I check your change.` : '',
              `@${coder}: edit the working copy and reply \`@${this.patcherClient.agentName} verify ${incidentId}\`, or send a diff (in a \`\`\`diff block, or \`POST ${this.opts.checkoutService.getBaseUrl().replace(/:\d+$/, ':' + (process.env.VIGIL_PORT || '4010'))}/api/incidents/${incidentId}/stage-patch\`). Only a passing change goes on to #${this.teamPrefix}-releases.`,
            ]
              .filter(Boolean)
              .join('\n'),
          );
          return;
        }

        await this.patcherClient.assumeRole(hotfixRoomId, 'patch-author');
        await this.patcherClient.postMessage(
          hotfixRoomId,
          `**${incidentId}: patching.** I hold \`patch-author\`. Reproducing on the live service, reverting the regression commit, then running the tests and replaying the failing request on staging.`,
        );
        const verification = await this.opts.checkoutService.reproduceAndStagePatch(incidentId, scenarioId);
        await this.completeVerificationAndHandoff(incidentId, verification, hotfixRoomId);
        return;
      }

      // External coder edited the working copy in place and asks for verification: `verify INC-xxxx`
      const verifyCmd = body.match(/\bverify\b(?:\s+(INC-[0-9A-Z-]+))?/i);
      if (verifyCmd && !/```/.test(body)) {
        const cited = verifyCmd[1]?.toUpperCase();
        const active = (cited && this.incidents.get(cited)) || this.getActiveIncident();
        if (!active || active.resolvedAt !== null) {
          await this.patcherClient.postMessage(event.room_id, `No open incident to verify.`);
          return;
        }
        const author = event.payload.sender_name || event.payload.sender;
        await this.patcherClient.assumeRole(this.roomsByRole.hotfixRoomId, 'red-team-verifier').catch(() => undefined);
        await this.patcherClient.postMessage(
          event.room_id,
          `**${active.incidentId}: checking ${author}'s change.** Committing the edits in \`${this.opts.checkoutService.getWorkDir()}\`, then running the tests and a staging replay.`,
        );
        const verification = await this.opts.checkoutService.stageExternalPatch(active.incidentId, active.scenarioId, {
          diffUnified: '',
          author,
        });
        await this.completeVerificationAndHandoff(active.incidentId, verification, this.roomsByRole.hotfixRoomId);
        return;
      }

      // External coder hands a diff to the verifier in chat: ```diff ... ```
      const fence = body.match(/```(?:diff|patch)?\s*\n([\s\S]*?)```/i);
      if (fence && /^(\+\+\+|---|@@|[+-])/m.test(fence[1])) {
        const cited = body.match(/\b(INC-[0-9A-Z-]+)\b/i)?.[1]?.toUpperCase();
        const active = cited ? this.incidents.get(cited) ?? this.getActiveIncident() : this.getActiveIncident();
        if (!active) {
          await this.patcherClient.postMessage(event.room_id, `No open incident to verify a patch against.`);
          return;
        }
        const author = event.payload.sender_name || event.payload.sender;
        await this.patcherClient.postMessage(
          event.room_id,
          `**${active.incidentId}: diff received from ${author}.** Running the reproduction and the tests.`,
        );
        const verification = await this.opts.checkoutService.stageExternalPatch(active.incidentId, active.scenarioId, {
          diffUnified: fence[1],
          author,
        });
        await this.completeVerificationAndHandoff(active.incidentId, verification, this.roomsByRole.hotfixRoomId);
        return;
      }

      if (/\b(diff|patch|tests)\b/i.test(body)) {
        const active = this.getActiveIncident();
        if (active?.patchVerification) {
          await this.patcherClient.postMessage(
            event.room_id,
            `**Staged diff for ${active.incidentId}** (\`${active.patchVerification.candidateVersion}\`):\n\`\`\`diff\n${active.patchVerification.diffUnified}\n\`\`\``,
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

  /** HTTP intake used by coding agents that call `POST /api/incidents/{id}/stage-patch` (see CLAUDE.md). */
  public async stageExternalPatchViaApi(
    incidentId: string,
    submission: { diffUnified: string; author?: string; touchedFiles?: string[] },
  ): Promise<PatchVerificationResult> {
    const rec = this.incidents.get(incidentId.toUpperCase());
    if (!rec) throw new Error(`Unknown incident ${incidentId}`);
    if (rec.resolvedAt !== null) throw new Error(`${rec.incidentId} is already resolved`);
    const author = submission.author?.trim() || this.getExternalCoderHandle();
    const hotfixRoomId = this.roomsByRole.hotfixRoomId;
    await this.patcherClient.assumeRole(hotfixRoomId, 'red-team-verifier').catch(() => undefined);
    await this.patcherClient.postMessage(
      hotfixRoomId,
      `**${rec.incidentId}: diff received from ${author}** through the stage-patch API. Running the reproduction and the tests.`,
    );
    const verification = await this.opts.checkoutService.stageExternalPatch(rec.incidentId, rec.scenarioId, {
      diffUnified: submission.diffUnified,
      author,
      touchedFiles: submission.touchedFiles,
    });
    await this.completeVerificationAndHandoff(rec.incidentId, verification, hotfixRoomId);
    return verification;
  }

  /** Shared tail of the patch stage: report doc, chat summary, release of leases, handoff (or hold) to the gate. */
  private async completeVerificationAndHandoff(
    incidentId: string,
    verification: PatchVerificationResult,
    hotfixRoomId: string,
  ): Promise<void> {
    const rec = this.incidents.get(incidentId);
    if (rec) {
      rec.patchVerification = verification;
      this.opts.onEventUpdate?.();
    }
    const external = verification.source === 'external-coder';
    const passed = verification.testMatrix.filter((t) => t.passed).length;
    const total = verification.testMatrix.length;

    const reportMarkdown = [
      `# Patch verification: ${incidentId}`,
      `- **Author:** ${verification.author} (${external ? 'external coding agent' : 'Vigil'}). **Checked by:** ${this.patcherClient.agentName}`,
      `- **Candidate:** \`${verification.candidateVersion}\`, commit \`${verification.candidateSha ?? 'discarded'}\`: ${verification.changedLines} changed lines in \`${verification.touchedFiles.join(', ') || 'n/a'}\``,
      `- **Reproduced:** ${verification.reproConfirmed ? 'yes' : 'no'}: \`${verification.reproErrorOutput}\``,
      `- **Result:** ${verification.allPassed ? `passed, ${passed} of ${total}` : `failed, ${passed} of ${total} (cannot ship)`}`,
      '',
      '## Diff',
      '```diff',
      verification.diffUnified,
      '```',
      '',
      '## Checks (the service tests and a staging replay)',
      ...verification.testMatrix.map((t) => `- [${t.passed ? 'x' : ' '}] **${t.name}** — ${t.detail}`),
      '',
      '## Test output (last lines)',
      '```',
      verification.testRunOutput.trim().split('\n').slice(-25).join('\n'),
      '```',
    ].join('\n');

    await this.patcherClient.createRoomDocument(hotfixRoomId, {
      name: 'patch-verification-report',
      description: `Reproduction output, diff, and regression matrix for ${incidentId}`,
      instructions: 'Inspected by Release Gate and human reviewers prior to canary promotion.',
      content: reportMarkdown,
    });

    if (rec?.workroom && !rec.workroom.archived) {
      await this.patcherClient
        .postMessage(
          rec.workroom.roomId,
          `**${incidentId}: ${verification.allPassed ? 'passed' : 'failed'} ${passed} of ${total} checks.** Candidate \`${verification.candidateVersion}\` by ${verification.author}. Full report: \`patch-verification-report\` in #${this.teamPrefix}-hotfix.`,
        )
        .catch(() => undefined);
    }

    if (!verification.allPassed) {
      await this.patcherClient.postMessage(
        hotfixRoomId,
        [
          `**${incidentId}: change rejected, ${passed} of ${total} checks passed.** ${verification.author}'s change fails:`,
          ...verification.testMatrix.filter((t) => !t.passed).map((t) => `- ${t.name}: ${t.detail}`),
          `It stays here until a corrected change passes; nothing reaches #${this.teamPrefix}-releases before then.`,
        ].join('\n'),
      );
      return;
    }

    await this.patcherClient.postMessage(
      hotfixRoomId,
      [
        `**${incidentId}: fix verified**${external ? `, written by ${verification.author}` : ''}.`,
        `1. Reproduced on the live service: \`${verification.reproErrorOutput}\``,
        `2. Candidate \`${verification.candidateVersion}\`, commit \`${verification.candidateSha ?? 'n/a'}\`: ${verification.changedLines} changed lines in ${verification.touchedFiles.map((f) => `\`${f}\``).join(', ') || 'no files'}. Not deployed yet.`,
        '```diff',
        verification.diffUnified,
        '```',
        `3. Tests and staging replay: ${passed} of ${total} passed.`,
        `Saved \`patch-verification-report\`. Handing off to #${this.teamPrefix}-releases.`,
      ].join('\n'),
    );

    const links = await this.patcherClient.listLinkedRooms(hotfixRoomId);
    const releaseLink = links.find((l) => l.from_room_id === hotfixRoomId && l.to_room_name.includes('releases'));
    const targetReleaseRoomId = releaseLink?.to_room_id ?? this.roomsByRole.releasesRoomId;
    const gateHandle = `${this.teamPrefix}-release-gate`;

    await this.patcherClient.releaseRole(hotfixRoomId, external ? 'red-team-verifier' : 'patch-author');

    await this.patcherClient.sendTargetedMessage(
      targetReleaseRoomId,
      gateHandle,
      `@${gateHandle} **[HANDOFF ${incidentId}]** Candidate \`${verification.candidateVersion}\` by ${verification.author}: ${verification.changedLines} changed lines, ${passed} of ${total} checks passed. Ready for a human decision.`,
    );
  }

  /** Read the live `release-safety-policy` room document and parse it into gate parameters. */
  private async loadReleasePolicy(): Promise<ReleasePolicy> {
    try {
      const docs = await this.releaseGateClient.loadInternalDocuments(this.roomsByRole.releasesRoomId);
      const doc = docs.find((d) => d.name === 'release-safety-policy');
      this.releasePolicy = ReleaseSafetyGate.parsePolicyDocument(doc?.content);
    } catch {
      // keep last known policy
    }
    return this.releasePolicy;
  }

  private async writeReleasePolicy(policy: ReleasePolicy, changedBy: string): Promise<void> {
    const roomId = this.roomsByRole.releasesRoomId;
    const content = ReleaseSafetyGate.renderPolicyDocument(policy, changedBy, this.teamPrefix);
    try {
      await this.releaseGateClient.updateRoomDocument(roomId, 'release-safety-policy', content);
    } catch {
      await this.releaseGateClient.createRoomDocument(roomId, {
        name: 'release-safety-policy',
        description: 'The rules the release gate checks before shipping',
        instructions: 'Enforced on every production deployment or rollback.',
        content,
      });
    }
    this.releasePolicy = policy;
    this.opts.onEventUpdate?.();
  }

  // ---------------------------------------------------------------------------------------------
  // Incident-commander failover (exclusive lease + `taken_over` fencing + cursor resume)
  // ---------------------------------------------------------------------------------------------

  /** Chaos: wedge the live sentinel process. Its socket stays open but it stops answering pings. */
  public crashSentinel(): { connectionId: string; generation: number | null; cursor: number } {
    this.sentinelClient.simulateHang();
    this.opts.onEventUpdate?.();
    return {
      connectionId: this.sentinelClient.connectionId,
      generation: this.sentinelClient.getGeneration() ?? null,
      cursor: this.sentinelClient.getCursor(),
    };
  }

  /**
   * Standby takeover: a fresh sentinel process reopens the SAME `connection_id` from the last
   * acknowledged cursor. The server evicts the wedged socket with `evicted: taken_over` (which the
   * old client treats as final), the new generation resumes the event stream without gaps, and the
   * exclusive `incident-commander` lease is re-asserted so the open incident keeps its commander.
   */
  public async failoverSentinel(): Promise<SentinelFailoverRecord> {
    if (!this.sentinelCreds) throw new Error('Sentinel credentials unavailable');
    const old = this.sentinelClient;
    const previousGeneration = old.getGeneration() ?? null;
    const resumedFromCursor = old.getCursor();

    const standby = new SwitchAgentClient({
      baseUrl: this.opts.switchServerUrl,
      agentId: this.sentinelCreds.id,
      agentName: old.agentName,
      apiKey: this.sentinelCreds.api_key,
      connectionId: old.connectionId,
      initialCursor: resumedFromCursor,
      scope: 'all',
      filter: 'all',
      onTrace: this.recordTrace,
      clientName: 'vigil-switch-sdk-standby',
    });

    this.retiredSentinels.push(old);
    this.sentinelClient = standby;
    this.wireSentinelHandlers();
    await standby.discoverOperations();
    await standby.connect();

    // Give the server a beat to deliver `evicted: taken_over` to the wedged socket.
    await new Promise((r) => setTimeout(r, 150));

    const active = this.getActiveIncident();
    let leaseReclaimed = false;
    if (active && active.resolvedAt === null) {
      try {
        await standby.assumeRole(this.roomsByRole.incidentsRoomId, 'incident-commander');
        leaseReclaimed = true;
      } catch {
        leaseReclaimed = false;
      }
    }

    const ctx = await standby.readContext(this.roomsByRole.incidentsRoomId, 10).catch(() => null);
    const record: SentinelFailoverRecord = {
      at: Date.now(),
      trigger: 'chaos_hang',
      previousGeneration,
      newGeneration: standby.getGeneration() ?? null,
      resumedFromCursor,
      leaseReclaimed,
      previousConnectionEvicted: old.isStoppedPermanently(),
    };
    this.failovers.push(record);

    await standby.postMessage(
      this.roomsByRole.incidentsRoomId,
      [
        `**Incident commander failed over.** A standby sentinel took over connection \`${old.connectionId.slice(0, 8)}…\`.`,
        `- Previous generation \`${previousGeneration ?? '-'}\` evicted with \`taken_over\` (${record.previousConnectionEvicted ? 'confirmed' : 'pending'}); now generation \`${record.newGeneration ?? '-'}\`.`,
        `- Resumed event stream from cursor \`${resumedFromCursor}\` (${ctx ? `${ctx.messages.length} recent messages re-read` : 'context re-read skipped'}).`,
        active && active.resolvedAt === null
          ? `- Exclusive \`incident-commander\` lease for \`${active.incidentId}\` ${leaseReclaimed ? 're-asserted — incident keeps its commander' : 'could NOT be reclaimed'}.`
          : '- No open incident; standing by.',
      ].join('\n'),
    );
    this.opts.onEventUpdate?.();
    return record;
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
            `**${incidentId} needs a human decision.** @${operator}`,
            `- Incident: ${rec.title} (commit \`${rec.alert.suspectedCommit.sha}\`)`,
            `- Fix: \`${v?.candidateVersion ?? 'v2.14.1-hotfix'}\` by ${v?.author ?? 'vigil-patcher'}, ${v?.changedLines ?? 0} changed lines, ${v?.testMatrix.filter((t) => t.passed).length ?? 0} of ${v?.testMatrix.length ?? 0} checks passed`,
            `- Policy: at most ${this.releasePolicy.maxChangedLines} changed lines; approvers: ${this.releasePolicy.allowedApprovers.join(', ')}`,
            `- Rollback target: \`${rec.alert.lastKnownGoodVersion}\``,
            '',
            `Reply with one of these. Approvals from agents are refused.`,
            `- Ship the fix: \`@${gateName} approve ${incidentId} promote\``,
            `- Roll back: \`@${gateName} approve ${incidentId} rollback\``,
          ].join('\n'),
        );
        return;
      }

      // 1b. Policy governance from chat: humans edit the `release-safety-policy` room document; agents may not.
      const policyCmd = ReleaseSafetyGate.parsePolicyCommand(body);
      if (policyCmd) {
        const senderIsAgent = ReleaseSafetyGate.evaluate({
          senderParticipantId: event.payload.sender,
          senderName: event.payload.sender_name,
          senderKind: event.payload.sender_kind,
          messageBody: 'approve INC-0000 promote',
          activeIncidentId: 'INC-0000',
          knownAgentParticipantIds: this.knownAgentParticipantIds,
          knownAgentNames: this.knownAgentNames,
          patchVerification: null,
        }).reasonCode === 'REJECTED_AGENT_SENDER';

        if (senderIsAgent) {
          this.policyAudit.push({
            at: Date.now(),
            senderName: event.payload.sender_name,
            senderParticipantId: event.payload.sender,
            accepted: false,
            summary: `BLOCKED ${policyCmd.summary}`,
          });
          this.opts.onEventUpdate?.();
          await this.releaseGateClient.postMessage(
            event.room_id,
            `**Policy change refused (REJECTED_AGENT_SENDER).** ${event.payload.sender_name} is an agent; only people can change \`release-safety-policy\`.`,
          );
          return;
        }

        const current = await this.loadReleasePolicy();
        const next = ReleaseSafetyGate.applyPolicyCommand(current, policyCmd);
        await this.writeReleasePolicy(next, event.payload.sender_name);
        this.policyAudit.push({
          at: Date.now(),
          senderName: event.payload.sender_name,
          senderParticipantId: event.payload.sender,
          accepted: true,
          summary: policyCmd.summary,
        });
        this.opts.onEventUpdate?.();
        await this.releaseGateClient.postMessage(
          event.room_id,
          [
            `**Policy updated by ${event.payload.sender_name}:** ${policyCmd.summary}`,
            `Saved to the \`release-safety-policy\` room document. It applies from the next approval.`,
            `- max_changed_lines: \`${next.maxChangedLines}\` · forbidden_paths: \`${next.forbiddenPaths.join(', ') || 'none'}\` · require_green_matrix: \`${next.requireGreenMatrix}\` · allowed_approvers: \`${next.allowedApprovers.join(', ')}\` · min_canary_probes: \`${next.minCanaryProbes}\``,
          ].join('\n'),
        );
        return;
      }

      if (/\b(policy|show policy)\b/i.test(body) && !/\b(approve|ship|execute|rollback)\b/i.test(body)) {
        const pol = await this.loadReleasePolicy();
        await this.releaseGateClient.postMessage(
          event.room_id,
          [
            `**Release policy** (from the \`release-safety-policy\` room document):`,
            `- max_changed_lines: \`${pol.maxChangedLines}\``,
            `- forbidden_paths: \`${pol.forbiddenPaths.join(', ') || 'none'}\``,
            `- require_green_matrix: \`${pol.requireGreenMatrix}\``,
            `- allowed_approvers: \`${pol.allowedApprovers.join(', ')}\``,
            `- min_canary_probes: \`${pol.minCanaryProbes}\``,
            `People can change it: \`set max diff 60\`, \`set approvers priya,sam\`, \`set forbidden paths .env,secret\`, \`set green matrix off\`.`,
          ].join('\n'),
        );
        return;
      }

      // 2. Evaluate an approval or rollback with the release gate (plain code, no model)
      const active = this.getActiveIncident();
      if (!active || active.resolvedAt !== null) {
        if (/\b(approve|ship|execute|rollback)\b/i.test(body)) {
          const cited = body.match(/INC-[0-9A-Z-]+/i)?.[0]?.toUpperCase();
          const closed = cited ? this.incidents.get(cited) : undefined;
          await this.releaseGateClient.postMessage(
            event.room_id,
            closed
              ? `**Nothing to do.** ${cited} is already ${closed.stage.replace(/_/g, ' ')}${closed.finalVersion ? ` (\`${closed.finalVersion}\`)` : ''}.`
              : `**Nothing is waiting for approval.** ${cited ? `${cited} is not an open incident.` : 'There is no open incident.'}`,
          );
          return;
        }
        if (/\b(status|help)\b/i.test(body)) {
          const pol = this.releasePolicy;
          await this.releaseGateClient.postMessage(
            event.room_id,
            `**Nothing is waiting for approval.** To ship, I need: a person (not an agent), the incident ID, ${pol.requireGreenMatrix ? 'passing tests' : 'tests (advisory)'}, at most ${pol.maxChangedLines} changed lines, an approver from ${pol.allowedApprovers.join(', ')}, and ${pol.minCanaryProbes} passing canary probes after the deploy.`,
          );
        }
        return;
      }

      // Only run gate evaluation when message attempts an approval/rollback or comes from an agent trying to approve
      if (/\b(approve|ship|execute|rollback)\b/i.test(body)) {
        const policy = await this.loadReleasePolicy();
        const decision = ReleaseSafetyGate.evaluate({
          senderParticipantId: event.payload.sender,
          senderName: event.payload.sender_name,
          senderKind: event.payload.sender_kind,
          messageBody: body,
          activeIncidentId: active.incidentId,
          knownAgentParticipantIds: this.knownAgentParticipantIds,
          knownAgentNames: this.knownAgentNames,
          patchVerification: active.patchVerification,
          lastKnownGoodVersion: active.alert.lastKnownGoodVersion,
          policy,
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
            `**Refused (${decision.reasonCode}).** ${decision.explanation}`,
          );
          return;
        }

        // Approved by verified human! Apply release/rollback & run live HTTP synthetic canary probes
        await this.releaseGateClient.postMessage(
          event.room_id,
          decision.action === 'promote'
            ? `**${active.incidentId}: deploying.** Restarting checkout-api from the verified commit \`${active.patchVerification?.candidateSha ?? 'HEAD'}\` (\`${active.patchVerification?.candidateVersion}\`), then running the canary probes.`
            : `**${active.incidentId}: rolling back** to \`${active.alert.lastKnownGoodVersion}\` and restarting checkout-api, then running the canary probes.`,
        );
        const outcome = await this.opts.checkoutService.applyApprovedRelease(decision.action);
        active.canaryReport = outcome.canaryReport;
        const report = outcome.canaryReport;
        const canaryOk =
          report.probesRun > 0 && report.probesPassed === report.probesRun && report.probesPassed >= policy.minCanaryProbes;
        if (!canaryOk) {
          // The deploy happened, but the service is not proven healthy: the incident stays open for a person.
          this.opts.onEventUpdate?.();
          await this.releaseGateClient.postMessage(
            event.room_id,
            [
              `**${active.incidentId}: not closing.** \`${outcome.deployedVersion}\` is running, but ${report.probesPassed} of ${report.probesRun} canary probes passed (the policy needs all of them, and at least ${policy.minCanaryProbes}).`,
              ...report.details.filter((d) => !/\bOK\b/.test(d)).map((d) => `- ${d}`),
              decision.action === 'promote'
                ? `Roll back with \`@${this.teamPrefix}-release-gate approve ${active.incidentId} rollback\`, or ship another fix.`
                : 'The last good release is not healthy either; this needs a person to look at the service.',
            ].join('\n'),
          );
          return;
        }
        this.opts.checkoutService.settleRelease();
        active.finalVersion = outcome.deployedVersion;
        active.resolvedAt = Date.now();
        active.stage =
          decision.action === 'promote' ? 'resolved_promoted' : 'resolved_rolled_back';
        if (this.activeIncidentId === active.incidentId) {
          this.activeIncidentId = null;
        }
        this.opts.onEventUpdate?.();

        // Publish the postmortem room document in `#vigil-releases`
        const durationSec = Math.max(1, Math.round((active.resolvedAt - active.openedAt) / 1000));
        const postmortemDoc = [
          `# Postmortem: ${active.incidentId}`,
          `- **Incident:** ${active.title}`,
          `- **Resolution Action:** \`${decision.action.toUpperCase()}\` -> \`${outcome.deployedVersion}\` (Approved by human \`${event.payload.sender_name}\`; candidate authored by \`${active.patchVerification?.author ?? 'n/a'}\`)`,
          `- **Workroom:** ${active.workroom ? `\`#${active.workroom.roomName}\` (archived at closure)` : 'none'}`,
          `- **Time to Resolution (MTTR):** ${durationSec}s across linked Switch rooms`,
          `- **Root Cause:** Commit \`${active.alert.suspectedCommit.sha}\` (\`${active.alert.suspectedCommit.filePath}:${active.alert.suspectedCommit.line}\`) — ${active.alert.errorMessage}`,
          `- **Canary probes after deploy:** ${outcome.canaryReport.probesPassed} of ${outcome.canaryReport.probesRun} passed (slowest ${outcome.canaryReport.maxLatencyMs} ms)`,
          '',
          '## Canary probes',
          ...outcome.canaryReport.details.map((d) => `- ${d}`),
        ].join('\n');

        await this.releaseGateClient.createRoomDocument(releasesRoomId, {
          name: `postmortem-${active.incidentId.toLowerCase()}`,
          description: `Postmortem and canary results for ${active.incidentId}`,
          instructions: 'Written by the release gate when the incident closed.',
          content: postmortemDoc,
        });

        await this.releaseGateClient.postMessage(
          releasesRoomId,
          [
            `**${active.incidentId} ${decision.action === 'promote' ? 'shipped' : 'rolled back'}: \`${outcome.deployedVersion}\` at \`${outcome.sha}\`.**`,
            `- Approved by ${event.payload.sender_name} (\`${event.payload.sender}\`)`,
            `- Canary probes: ${outcome.canaryReport.probesPassed} of ${outcome.canaryReport.probesRun} passed (slowest ${outcome.canaryReport.maxLatencyMs} ms)`,
            `- Postmortem saved as \`postmortem-${active.incidentId.toLowerCase()}\`. Telling #${this.teamPrefix}-incidents.`,
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
          `@${sentinelHandle} **[RESOLVED ${active.incidentId} mode=${decision.action} version=${outcome.deployedVersion}]** Approved by ${event.payload.sender_name}; ${report.probesPassed} of ${report.probesRun} canary probes passed.`,
        );
      }
    });
  }
}
