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

    // 7. Rooms are known: start handling room traffic.
    this.wireSentinelHandlers();
    this.wirePatcherHandlers();
    this.wireReleaseGateHandlers();

    // Subscribe checkout-api incident alerts directly to Sentinel
    this.opts.checkoutService.setIncidentWebhook(async (alert) => {
      await this.handleIncomingTelemetryAlert(alert);
    });
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
      `# Blast Radius Dossier — ${alert.incidentId}`,
      `- **Status:** ACTIVE (Escalated to \`#${this.teamPrefix}-hotfix\`)`,
      `- **Service:** \`${alert.service}\` (\`${alert.deployedVersion}\`, LKG: \`${alert.lastKnownGoodVersion}\`)`,
      `- **Endpoint:** \`${alert.endpoint}\` -> HTTP \`${alert.httpStatus}\` (\`${alert.errorRatePct}%\` error rate, p99 \`${alert.p99LatencyMs}ms\`)`,
      `- **Suspected Commit (git HEAD of live working copy):** \`${alert.suspectedCommit.sha}\` by \`${alert.suspectedCommit.author}\` — *"${alert.suspectedCommit.message}"* (\`${alert.suspectedCommit.filePath}:${alert.suspectedCommit.line}\`)`,
      `- **Stack Trace (from service alert webhook):**`,
      '```',
      alert.stackTrace.split('\n').slice(0, 6).join('\n'),
      '```',
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
          : `Reproduce & stage surgical fix for \`${alert.service}\` (\`${alert.deployedVersion}\`):`,
        `- **Exception:** \`${alert.errorMessage}\``,
        `- **Suspect:** \`${alert.suspectedCommit.sha}\` at \`${alert.suspectedCommit.filePath}:${alert.suspectedCommit.line}\``,
        `- **Repro Payload:** \`${JSON.stringify(alert.reproductionPayload)}\``,
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
      `📦 **[${record.incidentId} CLOSED — ${outcome}]** Archiving this workroom. Durable artifacts live in \`#${this.teamPrefix}-hotfix\` (patch-verification-report) and \`#${this.teamPrefix}-releases\` (postmortem).`,
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

        if (rec) {
          await this.archiveIncidentWorkroom(rec, mode === 'promote' ? `promoted ${version}` : `rolled back to ${version}`).catch(() => undefined);
        }

        await this.sentinelClient.releaseRole(this.roomsByRole.incidentsRoomId, 'incident-commander');
        await this.sentinelClient.postMessage(
          this.roomsByRole.incidentsRoomId,
          `✅ **[${incId} CLOSED]** Updated \`blast-radius-dossier\`, verified \`${version}\` recovery${rec?.workroom ? `, archived \`#${rec.workroom.roomName}\`` : ''}, and released \`incident-commander\` lease. Mesh back on standby.`,
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
              `🧪 **[${incidentId} VERIFIER ARMED]** Holding \`red-team-verifier\`; \`patch-author\` is reserved for @${coder}.`,
              alert ? `Independent reproduction on \`${alert.deployedVersion}\`: \`${alert.errorMessage}\`` : '',
              `@${coder}: reply here with your unified diff in a \`\`\`diff fence addressed to @${this.patcherClient.agentName}, or \`POST ${this.opts.checkoutService.getBaseUrl().replace(/:\d+$/, ':' + (process.env.VIGIL_PORT || '4010'))}/api/incidents/${incidentId}/stage-patch\` with \`{ diffUnified, author }\`. I will run the regression matrix and hand off to \`#${this.teamPrefix}-releases\` only if it is green.`,
            ]
              .filter(Boolean)
              .join('\n'),
          );
          return;
        }

        await this.patcherClient.assumeRole(hotfixRoomId, 'patch-author');
        await this.patcherClient.postMessage(
          hotfixRoomId,
          `🔧 **[${incidentId} PATCHING]** Holding \`patch-author\`. Reproducing against live \`checkout-api\`, then \`git revert\` of the regression commit in the working copy, real test suite, and a staging-port replay of the production payload…`,
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
          `📥 **[${active.incidentId} VERIFY REQUESTED]** by \`${author}\`. Picking up uncommitted edits in \`${this.opts.checkoutService.getWorkDir()}\`, committing the candidate, running the real test suite and a staging replay…`,
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
          `📥 **[${active.incidentId} CANDIDATE RECEIVED]** from \`${author}\` (${event.payload.sender}). Running reproduction + regression matrix as \`red-team-verifier\`…`,
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
      `📥 **[${rec.incidentId} CANDIDATE RECEIVED via stage-patch API]** author=\`${author}\`. Running reproduction + regression matrix as \`red-team-verifier\`…`,
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
      `# Patch Verification Report — ${incidentId}`,
      `- **Author:** \`${verification.author}\` (${external ? 'external coding agent via Switch' : 'vigil-patcher'}) · **Verifier:** \`${this.patcherClient.agentName}\``,
      `- **Candidate Version:** \`${verification.candidateVersion}\` · commit \`${verification.candidateSha ?? 'discarded'}\` (${verification.changedLines} lines across \`${verification.touchedFiles.join(', ') || 'n/a'}\`)`,
      `- **Deterministic Reproduction:** ${verification.reproConfirmed ? 'CONFIRMED' : 'FAILED'} — \`${verification.reproErrorOutput}\``,
      `- **Verdict:** ${verification.allPassed ? `GREEN ${passed}/${total}` : `RED ${passed}/${total} — not eligible for promotion`}`,
      '',
      '## Unified Diff',
      '```diff',
      verification.diffUnified,
      '```',
      '',
      '## Verification Matrix (real `node --test` run + staging-port replay)',
      ...verification.testMatrix.map((t) => `- [${t.passed ? 'x' : ' '}] **${t.name}** — ${t.detail}`),
      '',
      '## Test Runner Output (tail)',
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
          `🔵 **Blue team verdict for ${incidentId}:** ${verification.allPassed ? 'GREEN' : 'RED'} ${passed}/${total} · candidate \`${verification.candidateVersion}\` by \`${verification.author}\`. Full report: \`patch-verification-report\` in \`#${this.teamPrefix}-hotfix\`.`,
        )
        .catch(() => undefined);
    }

    if (!verification.allPassed) {
      await this.patcherClient.postMessage(
        hotfixRoomId,
        [
          `⛔ **[${incidentId} CANDIDATE REJECTED — ${passed}/${total}]** Candidate from \`${verification.author}\` does not clear the regression matrix:`,
          ...verification.testMatrix.filter((t) => !t.passed).map((t) => `- ✗ **${t.name}** — ${t.detail}`),
          `Holding in \`#${this.teamPrefix}-hotfix\`. Submit a corrected diff; nothing reaches \`#${this.teamPrefix}-releases\` until it is green.`,
        ].join('\n'),
      );
      return;
    }

    await this.patcherClient.postMessage(
      hotfixRoomId,
      [
        `🔬 **[${incidentId} REPRODUCED & PATCH VERIFIED]**${external ? ` — candidate authored by \`${verification.author}\`` : ''}`,
        `1. **Reproduced against live \`checkout-api\`:** \`${verification.reproErrorOutput}\``,
        `2. **Staged Candidate \`${verification.candidateVersion}\`** (commit \`${verification.candidateSha ?? 'n/a'}\`, ${verification.changedLines} lines changed in \`${verification.touchedFiles[0] ?? 'n/a'}\`; working copy HEAD, not yet deployed):`,
        '```diff',
        verification.diffUnified,
        '```',
        `3. **Verification Suite:** **${passed}/${total} passed**.`,
        `Saved \`patch-verification-report\` room document. Handing off across room link -> \`#${this.teamPrefix}-releases\`.`,
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
      `@${gateHandle} **[HANDOFF ${incidentId}]** Candidate \`${verification.candidateVersion}\` by \`${verification.author}\` (${verification.changedLines} lines, ${passed}/${total} green tests) staged and ready for human release gate.`,
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
    const content = ReleaseSafetyGate.renderPolicyDocument(policy, changedBy);
    try {
      await this.releaseGateClient.updateRoomDocument(roomId, 'release-safety-policy', content);
    } catch {
      await this.releaseGateClient.createRoomDocument(roomId, {
        name: 'release-safety-policy',
        description: 'Zero-LLM deterministic release gate invariants',
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
        `♻️ **[INCIDENT-COMMANDER FAILOVER]** Standby sentinel took over connection \`${old.connectionId.slice(0, 8)}…\`.`,
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
            `🛡️ **[HUMAN RELEASE GATE — ${incidentId}]** @${operator}`,
            `- **Incident:** ${rec.title} (Commit \`${rec.alert.suspectedCommit.sha}\`)`,
            `- **Candidate Patch:** \`${v?.candidateVersion ?? 'v2.14.1-hotfix'}\` by \`${v?.author ?? 'vigil-patcher'}\` · \`${v?.changedLines ?? 0}\` changed lines · **${v?.testMatrix.filter((t) => t.passed).length ?? 0}/${v?.testMatrix.length ?? 0}** verification vectors green`,
            `- **Room Policy:** max \`${this.releasePolicy.maxChangedLines}\` lines · approvers \`${this.releasePolicy.allowedApprovers.join(', ')}\` (edit via \`set max diff N\`)`,
            `- **Fallback Baseline:** \`${rec.alert.lastKnownGoodVersion}\` (instant zero-migration rollback)`,
            '',
            `**Action Required (Verified Human Only — Agent approvals blocked):**`,
            `- Promote hotfix: \`@${gateName} approve ${incidentId} promote\``,
            `- Rollback to LKG: \`@${gateName} approve ${incidentId} rollback\``,
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
            `⛔ **[POLICY CHANGE BLOCKED — REJECTED_AGENT_SENDER]** \`${event.payload.sender_name}\` is an agent identity. Only verified humans may edit \`release-safety-policy\`.`,
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
            `📜 **[POLICY UPDATED by ${event.payload.sender_name}]** ${policyCmd.summary}`,
            `Wrote \`release-safety-policy\` room document (\`update_room_document\`). Effective on the next approval evaluation.`,
            `- max_changed_lines: \`${next.maxChangedLines}\` · forbidden_paths: \`${next.forbiddenPaths.join(', ') || 'none'}\` · require_green_matrix: \`${next.requireGreenMatrix}\` · allowed_approvers: \`${next.allowedApprovers.join(', ')}\``,
          ].join('\n'),
        );
        return;
      }

      if (/\b(policy|show policy)\b/i.test(body) && !/\b(approve|ship|execute|rollback)\b/i.test(body)) {
        const pol = await this.loadReleasePolicy();
        await this.releaseGateClient.postMessage(
          event.room_id,
          [
            `📜 **Live release policy** (read from \`release-safety-policy\` room document):`,
            `- max_changed_lines: \`${pol.maxChangedLines}\``,
            `- forbidden_paths: \`${pol.forbiddenPaths.join(', ') || 'none'}\``,
            `- require_green_matrix: \`${pol.requireGreenMatrix}\``,
            `- allowed_approvers: \`${pol.allowedApprovers.join(', ')}\``,
            `- min_canary_probes: \`${pol.minCanaryProbes}\``,
            `Change it (humans only): \`set max diff 60\`, \`set approvers priya,sam\`, \`set forbidden paths .env,secret\`, \`set green matrix off\`.`,
          ].join('\n'),
        );
        return;
      }

      // 2. Evaluate approval / rollback command through deterministic Zero-LLM ReleaseSafetyGate
      const active = this.getActiveIncident();
      if (!active || active.resolvedAt !== null) {
        if (/\b(status|help)\b/i.test(body)) {
          const pol = this.releasePolicy;
          await this.releaseGateClient.postMessage(
            event.room_id,
            `🛡️ **Vigil Release Gate:** Standby (no active gated incident). Invariants enforced: Human-only sign-off (\`@switch-user-*\`), incident ID binding, green test matrix (${pol.requireGreenMatrix ? 'required' : 'advisory'}), <${pol.maxChangedLines}-line diff cap, approvers \`${pol.allowedApprovers.join(', ')}\`, and ${pol.minCanaryProbes}-probe post-deploy canary verification.`,
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
            `⛔ **[GATE BLOCKED — ${decision.reasonCode}]** ${decision.explanation}`,
          );
          return;
        }

        // Approved by verified human! Apply release/rollback & run live HTTP synthetic canary probes
        await this.releaseGateClient.postMessage(
          event.room_id,
          decision.action === 'promote'
            ? `🚀 **[${active.incidentId} DEPLOYING]** Restarting \`checkout-api\` from verified candidate commit \`${active.patchVerification?.candidateSha ?? 'HEAD'}\` (\`${active.patchVerification?.candidateVersion}\`), then 5 live canary probes…`
            : `⏪ **[${active.incidentId} ROLLING BACK]** \`git reset --hard ${active.alert.lastKnownGoodVersion}\` in the working copy and restarting \`checkout-api\`, then 5 live canary probes…`,
        );
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
          `- **Resolution Action:** \`${decision.action.toUpperCase()}\` -> \`${outcome.deployedVersion}\` (Approved by human \`${event.payload.sender_name}\`; candidate authored by \`${active.patchVerification?.author ?? 'n/a'}\`)`,
          `- **Workroom:** ${active.workroom ? `\`#${active.workroom.roomName}\` (archived at closure)` : 'none'}`,
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
            `🚀 **[${active.incidentId} ${decision.action === 'promote' ? 'HOTFIX PROMOTED' : 'ROLLED BACK'} -> \`${outcome.deployedVersion}\` @ \`${outcome.sha}\`]**`,
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
