import { createServer, IncomingMessage, Server as HttpServer, ServerResponse } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { URL } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import YAML from 'yaml';
import {
  RegisterAgentRequest,
  SwitchDomainEventFrame,
  SwitchIntegrationProfile,
  SwitchMessagePayload,
  SwitchParticipant,
  SwitchReference,
  SwitchRole,
  SwitchRoomDetail,
  SwitchRoomDocument,
  SwitchRoomLink,
} from '../protocol/types.js';

interface RegisteredAgentRecord {
  id: string;
  name: string;
  displayName: string;
  description: string;
  connectorType: string;
  integrationProfile: SwitchIntegrationProfile;
  apiKey: string;
  participantId: string;
  eventBuffer: SwitchDomainEventFrame[];
  nextSequence: number;
}

interface ActiveWsConnection {
  connectionId: string;
  agentId: string;
  generation: number;
  scope: 'single' | 'all';
  filter: 'all' | 'addressed';
  rooms: Set<string>;
  cursor: number;
  lastPongAt: number;
  ws: WebSocket;
}

export interface RoomMessageLogEntry extends SwitchMessagePayload {
  seq: number;
  room_id: string;
  room_name: string;
}

interface InternalRoomState {
  id: string;
  name: string;
  description: string;
  instructions: string;
  bridge: string | null;
  channelType: 'channel_public' | 'channel_private';
  groupName: string | null;
  aliases: Record<string, string>;
  roles: SwitchRole[];
  documents: SwitchRoomDocument[];
  references: SwitchReference[];
  agentNames: Set<string>;
  users: Set<string>;
  messages: RoomMessageLogEntry[];
  seq: number;
}

export interface SwitchServerHarnessOptions {
  port?: number;
  registrationKey?: string;
  pingIntervalMs?: number;
  heartbeatTtlMs?: number;
  onStateChange?: () => void;
}

const AGENT_NAME_REGEX = /^[a-z0-9][a-z0-9._-]*$/;

/**
 * Spec-Exact Switch Server Protocol Harness (`switch-core` compatible wire contract)
 *
 * Supports:
 * - `GET /health`
 * - `POST /agents` (Bearer registration key, 409 duplicate check, `overwrite: true`)
 * - `POST /rooms/from-yaml` (Switch v1 Group & Room YAML template provisioning)
 * - `GET /agents/:id/ops` & `POST /agents/:id/ops/:op` (`X-Switch-Connection-Id`, exclusive role leases, document authorship)
 * - `GET /agents/:id/connection/ws` (WebSocket frames, `connection_state`, 2s `ping`/`pong`, 6s TTL eviction, `expected_generation` fencing, `addressed` routing)
 * - `POST /gateway/human-message` (Team chat bridge from Mattermost / Discord / Telegram / Observatory UI)
 */
export class SwitchServerHarness {
  public readonly registrationKey: string;
  private readonly pingIntervalMs: number;
  private readonly heartbeatTtlMs: number;
  private readonly onStateChange?: () => void;

  private httpServer: HttpServer | null = null;
  private wss: WebSocketServer | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private boundPort = 0;

  private agentsById = new Map<string, RegisteredAgentRecord>();
  private agentsByName = new Map<string, RegisteredAgentRecord>();
  private agentsByApiKey = new Map<string, RegisteredAgentRecord>();
  private roomsById = new Map<string, InternalRoomState>();
  private roomsByName = new Map<string, InternalRoomState>();
  private links: SwitchRoomLink[] = [];
  private connections = new Map<string, ActiveWsConnection>(); // key: `${agentId}:${connectionId}`
  private generationCounter = 0;

  constructor(opts: SwitchServerHarnessOptions = {}) {
    this.registrationKey = opts.registrationKey ?? 'switch-reg-vigil-local-key';
    this.pingIntervalMs = opts.pingIntervalMs ?? 2000;
    this.heartbeatTtlMs = opts.heartbeatTtlMs ?? 6000;
    this.onStateChange = opts.onStateChange;
  }

  public getBaseUrl(): string {
    return `http://127.0.0.1:${this.boundPort}`;
  }

  public getPort(): number {
    return this.boundPort;
  }

  public async start(port = 0): Promise<number> {
    this.httpServer = createServer((req, res) => {
      this.handleHttp(req, res).catch((err) => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(err) }));
      });
    });

    this.wss = new WebSocketServer({ noServer: true });

    this.httpServer.on('upgrade', (req, socket, head) => {
      this.wss!.handleUpgrade(req, socket, head, (ws) => {
        this.handleWsConnection(req, ws);
      });
    });

    await new Promise<void>((resolve) => {
      this.httpServer!.listen(port, '127.0.0.1', () => {
        const addr = this.httpServer!.address();
        if (addr && typeof addr === 'object') {
          this.boundPort = addr.port;
        }
        resolve();
      });
    });

    this.pingTimer = setInterval(() => this.tickHeartbeats(), this.pingIntervalMs);
    return this.boundPort;
  }

  public async stop(): Promise<void> {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    for (const conn of this.connections.values()) {
      try {
        conn.ws.close(1000, 'server_shutdown');
      } catch {
        // ignore
      }
    }
    this.connections.clear();

    if (this.wss) {
      await new Promise<void>((resolve) => this.wss!.close(() => resolve()));
      this.wss = null;
    }
    if (this.httpServer) {
      await new Promise<void>((resolve) => this.httpServer!.close(() => resolve()));
      this.httpServer = null;
    }
  }

  private tickHeartbeats(): void {
    const now = Date.now();
    for (const [key, conn] of this.connections.entries()) {
      if (conn.ws.readyState !== WebSocket.OPEN) {
        this.connections.delete(key);
        continue;
      }
      if (now - conn.lastPongAt > this.heartbeatTtlMs) {
        // Evict lapsed connection and release any exclusive role leases it held
        this.releaseAllRolesForAgent(conn.agentId);
        conn.ws.send(
          JSON.stringify({
            type: 'evicted',
            code: 'heartbeat_lapsed',
            reason: `No pong within ${this.heartbeatTtlMs}ms TTL`,
          }),
        );
        conn.ws.close(1000, 'heartbeat_lapsed');
        this.connections.delete(key);
        this.notifyChange();
        continue;
      }
      conn.ws.send(JSON.stringify({ type: 'ping' }));
    }
  }

  private releaseAllRolesForAgent(agentId: string): void {
    for (const room of this.roomsById.values()) {
      for (const role of room.roles) {
        if (role.holder_agent_id === agentId) {
          role.holder_agent_id = null;
          role.holder_name = null;
          role.leased_at = null;
        }
      }
    }
  }

  private handleWsConnection(req: IncomingMessage, ws: WebSocket): void {
    const reqUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
    const match = reqUrl.pathname.match(/^\/agents\/([^/]+)\/connection\/ws$/);
    if (!match) {
      ws.close(4400, 'invalid_ws_path');
      return;
    }

    const authHeader = req.headers.authorization ?? '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    const agentId = decodeURIComponent(match[1]);
    const agent = this.agentsById.get(agentId);

    // Spec: Failed authentication closes with 4401 and no `refused` frame first.
    if (!agent || !token || agent.apiKey !== token) {
      ws.close(4401, 'unauthorized');
      return;
    }

    const connectionId = reqUrl.searchParams.get('connection_id');
    const scope = (reqUrl.searchParams.get('scope') ?? 'single') as 'single' | 'all';
    const filter = (reqUrl.searchParams.get('filter') ?? 'all') as 'all' | 'addressed';
    const startFromRaw = reqUrl.searchParams.get('start_from') ?? 'head';
    const expectedGenRaw = reqUrl.searchParams.get('expected_generation');
    const roomsParam = reqUrl.searchParams.get('rooms');

    if (
      !connectionId ||
      (scope !== 'single' && scope !== 'all') ||
      (filter !== 'all' && filter !== 'addressed')
    ) {
      ws.send(
        JSON.stringify({
          type: 'refused',
          status: 400,
          detail: 'Missing connection_id or invalid scope/filter',
        }),
      );
      ws.close(4400, 'bad_request');
      return;
    }

    const connKey = `${agent.id}:${connectionId}`;
    const existing = this.connections.get(connKey);

    if (existing && expectedGenRaw !== null) {
      const expectedGen = Number(expectedGenRaw);
      if (Number.isNaN(expectedGen) || existing.generation !== expectedGen) {
        ws.send(
          JSON.stringify({
            type: 'refused',
            status: 409,
            detail: 'taken_over: generation mismatch',
          }),
        );
        ws.close(4409, 'taken_over');
        return;
      }
    }

    // Takeover semantics: evict older live socket with `taken_over`
    if (existing && existing.ws.readyState === WebSocket.OPEN) {
      existing.ws.send(
        JSON.stringify({
          type: 'evicted',
          code: 'taken_over',
          reason: 'Reopened connection_id without matching expected_generation',
        }),
      );
      existing.ws.close(1000, 'taken_over');
    }

    const coveredRooms = new Set<string>();
    if (roomsParam) {
      for (const r of roomsParam.split(',').map((s) => s.trim()).filter(Boolean)) {
        const room = this.roomsById.get(r) ?? this.roomsByName.get(r);
        if (!room || !room.agentNames.has(agent.name)) {
          ws.send(
            JSON.stringify({
              type: 'refused',
              status: 403,
              detail: `Agent ${agent.name} is not a member of room ${r}`,
            }),
          );
          ws.close(4403, 'forbidden_room');
          return;
        }
        coveredRooms.add(room.id);
      }
    } else if (scope === 'all') {
      for (const room of this.roomsById.values()) {
        if (room.agentNames.has(agent.name)) {
          coveredRooms.add(room.id);
        }
      }
    }

    this.generationCounter += 1;
    const generation = this.generationCounter;
    const headSeq = agent.nextSequence - 1;
    const initialCursor =
      startFromRaw === 'head' ? Math.max(0, headSeq) : Math.max(0, Number(startFromRaw) || 0);

    const activeConn: ActiveWsConnection = {
      connectionId,
      agentId: agent.id,
      generation,
      scope,
      filter,
      rooms: coveredRooms,
      cursor: initialCursor,
      lastPongAt: Date.now(),
      ws,
    };
    this.connections.set(connKey, activeConn);

    ws.on('message', (raw) => {
      try {
        const frame = JSON.parse(raw.toString()) as { type?: string; cursor?: number };
        if (frame.type === 'pong') {
          activeConn.lastPongAt = Date.now();
          if (typeof frame.cursor === 'number' && frame.cursor > activeConn.cursor) {
            activeConn.cursor = frame.cursor;
          }
        }
      } catch {
        // Spec: server ignores non-pong frames without error
      }
    });

    ws.on('close', () => {
      const current = this.connections.get(connKey);
      if (current && current.generation === generation) {
        this.connections.delete(connKey);
      }
    });

    // Always send `connection_state` first
    ws.send(
      JSON.stringify({
        type: 'connection_state',
        connection_id: connectionId,
        agent_id: agent.id,
        generation,
        scope,
        filter,
        spawn_capable: false,
        rooms: Array.from(coveredRooms).sort(),
        cursor: initialCursor,
        protocol: 6,
        heartbeat_interval_seconds: Math.round(this.pingIntervalMs / 1000),
        server: { name: 'switch-core-harness', version: '0.31.0' },
        client: {
          name: reqUrl.searchParams.get('client') ?? 'unknown',
          version: reqUrl.searchParams.get('client_version') ?? '0.0.0',
        },
      }),
    );

    // Replay buffered events strictly after `start_from` if resuming
    if (startFromRaw !== 'head') {
      const replayAfter = Number(startFromRaw) || 0;
      const earliestHeld = agent.eventBuffer.length > 0 ? agent.eventBuffer[0].id : replayAfter + 1;
      if (replayAfter > 0 && agent.eventBuffer.length > 0 && replayAfter < earliestHeld - 1) {
        ws.send(
          JSON.stringify({
            type: 'gap',
            from_sequence: replayAfter,
            resumed_at: earliestHeld - 1,
            rooms: Array.from(coveredRooms),
            all_rooms: scope === 'all',
            reason: 'retention_expired',
          }),
        );
      }
      for (const buffered of agent.eventBuffer) {
        if (buffered.id > replayAfter && coveredRooms.has(buffered.data.room_id)) {
          this.deliverFrameToConnection(activeConn, buffered);
        }
      }
    }
  }

  private deliverFrameToConnection(conn: ActiveWsConnection, frame: SwitchDomainEventFrame): void {
    if (conn.ws.readyState !== WebSocket.OPEN) return;
    if (!conn.rooms.has(frame.data.room_id) && conn.scope !== 'all') return;

    if (conn.filter === 'addressed') {
      if (frame.event === 'command') return;
      if (frame.event === 'message') {
        const p = frame.data.payload as SwitchMessagePayload;
        if (!p.addressed) return;
      }
    }
    conn.ws.send(JSON.stringify(frame));
  }

  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');

    if (method === 'GET' && url.pathname === '/health') {
      this.sendJson(res, 200, { ok: true, service: 'switch-bridge', version: '0.31.0' });
      return;
    }

    if (method === 'POST' && url.pathname === '/agents') {
      const token = this.extractBearer(req);
      if (token !== this.registrationKey) {
        this.sendJson(res, 401, { error: 'Invalid or missing registration bearer key' });
        return;
      }
      const body = (await this.readJsonBody(req)) as RegisterAgentRequest;
      if (
        !body.name ||
        !AGENT_NAME_REGEX.test(body.name) ||
        !body.description ||
        !body.connector_type ||
        !body.integration_profile
      ) {
        this.sendJson(res, 400, { error: 'Invalid agent registration payload' });
        return;
      }

      const existing = this.agentsByName.get(body.name);
      if (existing && !body.overwrite) {
        this.sendJson(res, 409, { error: `Agent '${body.name}' already exists` });
        return;
      }

      if (existing && body.overwrite) {
        this.agentsByApiKey.delete(existing.apiKey);
        const newKey = `sw_agent_${randomBytes(16).toString('hex')}`;
        existing.apiKey = newKey;
        existing.description = body.description;
        existing.displayName = body.display_name ?? body.name;
        existing.integrationProfile = body.integration_profile;
        this.agentsByApiKey.set(newKey, existing);
        this.notifyChange();
        this.sendJson(res, 200, { id: existing.id, api_key: newKey });
        return;
      }

      const shortId = randomBytes(4).toString('hex');
      const id = `agt_${shortId}`;
      const apiKey = `sw_agent_${randomBytes(16).toString('hex')}`;
      const record: RegisteredAgentRecord = {
        id,
        name: body.name,
        displayName: body.display_name ?? body.name,
        description: body.description,
        connectorType: body.connector_type,
        integrationProfile: body.integration_profile,
        apiKey,
        participantId: `@switch-agent-${body.name}:switch.local`,
        eventBuffer: [],
        nextSequence: 1,
      };
      this.agentsById.set(id, record);
      this.agentsByName.set(body.name, record);
      this.agentsByApiKey.set(apiKey, record);
      this.notifyChange();
      this.sendJson(res, 201, { id, api_key: apiKey });
      return;
    }

    if (method === 'POST' && url.pathname === '/rooms/from-yaml') {
      const payload = (await this.readJsonBody(req)) as {
        yaml: string;
        params?: Record<string, string>;
        creator?: string;
      };
      const created = this.provisionFromTemplateYaml(
        payload.yaml,
        payload.params ?? {},
        payload.creator ?? 'priya',
      );
      this.notifyChange();
      this.sendJson(res, 201, created);
      return;
    }

    if (method === 'POST' && url.pathname === '/gateway/human-message') {
      const payload = (await this.readJsonBody(req)) as {
        room_id: string;
        username: string;
        display_name?: string;
        content: string;
        thread_id?: string;
      };
      const room = this.roomsById.get(payload.room_id) ?? this.roomsByName.get(payload.room_id);
      if (!room) {
        this.sendJson(res, 404, { error: `Unknown room ${payload.room_id}` });
        return;
      }
      const cleanHandle = (payload.username || 'priya').toLowerCase().replace(/[^a-z0-9_-]/g, '');
      // A handle that collides with a registered Switch agent can never be a human teammate:
      // Switch bridges namespace agents under `@switch-agent-*`, so the embedded harness mirrors
      // that and attributes the message to the agent identity (used by the UI's rogue-agent test).
      const isRegisteredAgent = this.agentsByName.has(cleanHandle);
      const participantId = isRegisteredAgent
        ? `@switch-agent-${cleanHandle}:switch.local`
        : `@switch-user-${cleanHandle}:switch.local`;
      if (!isRegisteredAgent) room.users.add(cleanHandle);
      const posted = this.commitMessageToRoom(
        room,
        participantId,
        payload.display_name ?? cleanHandle,
        payload.content,
        payload.thread_id ?? null,
      );
      this.notifyChange();
      this.sendJson(res, 200, { ...posted, sender: participantId });
      return;
    }

    if (method === 'GET' && url.pathname === '/gateway/state') {
      this.sendJson(res, 200, this.getSnapshot());
      return;
    }

    // Dynamic Operation Discovery: `GET /agents/:agentId/ops`
    const opsListMatch = url.pathname.match(/^\/agents\/([^/]+)\/ops$/);
    if (method === 'GET' && opsListMatch) {
      const agent = this.authenticateAgent(req, decodeURIComponent(opsListMatch[1]));
      if (!agent) {
        this.sendJson(res, 401, { error: 'Unauthorized agent API key' });
        return;
      }
      this.sendJson(res, 200, { operations: this.buildOperationsCatalog() });
      return;
    }

    // Operation Execution: `POST /agents/:agentId/ops/:operation`
    const opInvokeMatch = url.pathname.match(/^\/agents\/([^/]+)\/ops\/([^/]+)$/);
    if (method === 'POST' && opInvokeMatch) {
      const agentId = decodeURIComponent(opInvokeMatch[1]);
      const operation = decodeURIComponent(opInvokeMatch[2]);
      const agent = this.authenticateAgent(req, agentId);
      if (!agent) {
        this.sendJson(res, 401, { error: 'Unauthorized agent API key' });
        return;
      }
      const connId = (req.headers['x-switch-connection-id'] as string | undefined) ?? '';
      const args = (await this.readJsonBody(req)) as Record<string, unknown>;
      this.executeAgentOperation(agent, connId, operation, args, res);
      return;
    }

    // Connectionless message post (`POST /agents/:agentId/message`)
    const directMsgMatch = url.pathname.match(/^\/agents\/([^/]+)\/message$/);
    if (method === 'POST' && directMsgMatch) {
      const agent = this.authenticateAgent(req, decodeURIComponent(directMsgMatch[1]));
      if (!agent) {
        this.sendJson(res, 401, { error: 'Unauthorized agent API key' });
        return;
      }
      const body = (await this.readJsonBody(req)) as { room_id: string; content: string };
      const room = this.resolveRoom(body.room_id);
      if (!room || !room.agentNames.has(agent.name)) {
        this.sendJson(res, 403, { error: 'Agent is not a member of target room' });
        return;
      }
      const posted = this.commitMessageToRoom(
        room,
        agent.participantId,
        agent.displayName,
        body.content,
        null,
      );
      this.notifyChange();
      this.sendJson(res, 200, { result: posted });
      return;
    }

    this.sendJson(res, 404, { error: `Unknown route ${method} ${url.pathname}` });
  }

  private executeAgentOperation(
    agent: RegisteredAgentRecord,
    connId: string,
    operation: string,
    args: Record<string, unknown>,
    res: ServerResponse,
  ): void {
    const resolveMemberRoom = (roomIdOrName: unknown): InternalRoomState | null => {
      if (typeof roomIdOrName !== 'string' || !roomIdOrName) return null;
      const room = this.resolveRoom(roomIdOrName);
      if (!room || !room.agentNames.has(agent.name)) return null;
      return room;
    };

    switch (operation) {
      case 'list_rooms': {
        const list = Array.from(this.roomsById.values())
          .filter((r) => r.agentNames.has(agent.name))
          .map((r) => this.serializeRoomDetail(r));
        this.sendJson(res, 200, { result: list });
        return;
      }
      case 'get_room_detail':
      case 'connect_to_room': {
        const room = resolveMemberRoom(args.room_id);
        if (!room) {
          this.sendJson(res, 403, { error: `Agent ${agent.name} cannot access room ${String(args.room_id)}` });
          return;
        }
        if (operation === 'connect_to_room' && connId) {
          const conn = this.connections.get(`${agent.id}:${connId}`);
          if (conn) {
            if (conn.scope === 'single') conn.rooms.clear();
            conn.rooms.add(room.id);
          }
        }
        this.sendJson(res, 200, { result: this.serializeRoomDetail(room) });
        return;
      }
      case 'read_context': {
        const room = resolveMemberRoom(args.room_id);
        if (!room) {
          this.sendJson(res, 403, { error: 'Forbidden room' });
          return;
        }
        const limit = typeof args.limit === 'number' ? args.limit : 25;
        this.sendJson(res, 200, {
          result: {
            room: this.serializeRoomDetail(room),
            messages: room.messages.slice(-limit),
          },
        });
        return;
      }
      case 'post_message': {
        const room = resolveMemberRoom(args.room_id);
        if (!room) {
          this.sendJson(res, 403, { error: 'Forbidden room' });
          return;
        }
        if (typeof args.content !== 'string' || !args.content.trim()) {
          this.sendJson(res, 400, { error: 'Missing content string' });
          return;
        }
        const posted = this.commitMessageToRoom(
          room,
          agent.participantId,
          agent.displayName,
          args.content,
          typeof args.thread_id === 'string' ? args.thread_id : null,
        );
        this.notifyChange();
        this.sendJson(res, 200, { result: posted });
        return;
      }
      case 'send_targeted_message': {
        const room = resolveMemberRoom(args.room_id);
        if (!room) {
          this.sendJson(res, 403, { error: 'Forbidden room' });
          return;
        }
        const target = String(args.target_agent ?? '');
        const content = String(args.content ?? '');
        if (!target || !content) {
          this.sendJson(res, 400, { error: 'target_agent and content are required' });
          return;
        }
        const formatted = content.includes(`@${target}`) ? content : `@${target} ${content}`;
        const posted = this.commitMessageToRoom(
          room,
          agent.participantId,
          agent.displayName,
          formatted,
          null,
        );
        this.notifyChange();
        this.sendJson(res, 200, { result: posted });
        return;
      }
      case 'assume_role': {
        const room = resolveMemberRoom(args.room_id);
        if (!room) {
          this.sendJson(res, 403, { error: 'Forbidden room' });
          return;
        }
        const roleName = String(args.role_name ?? '');
        const role = room.roles.find((r) => r.name === roleName);
        if (!role) {
          this.sendJson(res, 404, { error: `Unknown role '${roleName}' in room ${room.name}` });
          return;
        }
        if (role.exclusive && role.holder_agent_id && role.holder_agent_id !== agent.id) {
          this.sendJson(res, 409, {
            error: `Exclusive role '${roleName}' is already leased by ${role.holder_name}`,
          });
          return;
        }
        role.holder_agent_id = agent.id;
        role.holder_name = agent.name;
        role.leased_at = Date.now();
        this.notifyChange();
        this.sendJson(res, 200, { result: { ...role } });
        return;
      }
      case 'release_role': {
        const room = resolveMemberRoom(args.room_id);
        if (!room) {
          this.sendJson(res, 403, { error: 'Forbidden room' });
          return;
        }
        const roleName = String(args.role_name ?? '');
        const role = room.roles.find((r) => r.name === roleName);
        if (!role) {
          this.sendJson(res, 404, { error: `Unknown role '${roleName}'` });
          return;
        }
        if (role.holder_agent_id === agent.id) {
          role.holder_agent_id = null;
          role.holder_name = null;
          role.leased_at = null;
          this.notifyChange();
          this.sendJson(res, 200, { result: { released: true } });
        } else {
          this.sendJson(res, 200, { result: { released: false } });
        }
        return;
      }
      case 'create_room_document': {
        const room = resolveMemberRoom(args.room_id);
        if (!room) {
          this.sendJson(res, 403, { error: 'Forbidden room' });
          return;
        }
        const docName = String(args.name ?? '');
        if (!docName) {
          this.sendJson(res, 400, { error: 'Document name required' });
          return;
        }
        const existing = room.documents.find((d) => d.name === docName);
        if (existing) {
          // Upsert if owned by same agent, else 403 authorship enforcement!
          if (existing.created_by_agent_id !== agent.id && existing.created_by_agent_id !== 'system') {
            this.sendJson(res, 403, {
              error: `Room document '${docName}' was created by ${existing.created_by_name}; authorship is enforced`,
            });
            return;
          }
          existing.content = String(args.content ?? existing.content);
          existing.description = String(args.description ?? existing.description);
          existing.instructions = String(args.instructions ?? existing.instructions);
          existing.created_by_agent_id = agent.id;
          existing.created_by_name = agent.name;
          existing.updated_at = Date.now();
          this.notifyChange();
          this.sendJson(res, 200, { result: { ...existing } });
          return;
        }
        const doc: SwitchRoomDocument = {
          name: docName,
          description: String(args.description ?? ''),
          instructions: String(args.instructions ?? ''),
          content: String(args.content ?? ''),
          created_by_agent_id: agent.id,
          created_by_name: agent.name,
          updated_at: Date.now(),
        };
        room.documents.push(doc);
        this.notifyChange();
        this.sendJson(res, 200, { result: { ...doc } });
        return;
      }
      case 'update_room_document': {
        const room = resolveMemberRoom(args.room_id);
        if (!room) {
          this.sendJson(res, 403, { error: 'Forbidden room' });
          return;
        }
        const docName = String(args.name ?? '');
        const existing = room.documents.find((d) => d.name === docName);
        if (!existing) {
          this.sendJson(res, 404, { error: `Document '${docName}' not found in ${room.name}` });
          return;
        }
        // Spec: An agent can change or delete ONLY a document it created!
        if (existing.created_by_agent_id !== agent.id && existing.created_by_agent_id !== 'system') {
          this.sendJson(res, 403, {
            error: `Authorship violation: '${docName}' belongs to ${existing.created_by_name}`,
          });
          return;
        }
        existing.content = String(args.content ?? '');
        existing.updated_at = Date.now();
        this.notifyChange();
        this.sendJson(res, 200, { result: { ...existing } });
        return;
      }
      case 'load_internal_documents': {
        const room = resolveMemberRoom(args.room_id);
        if (!room) {
          this.sendJson(res, 403, { error: 'Forbidden room' });
          return;
        }
        this.sendJson(res, 200, { result: room.documents.map((d) => ({ ...d })) });
        return;
      }
      case 'list_linked_rooms': {
        const room = resolveMemberRoom(args.room_id);
        if (!room) {
          this.sendJson(res, 403, { error: 'Forbidden room' });
          return;
        }
        const linked = this.links.filter(
          (l) => l.from_room_id === room.id || l.to_room_id === room.id,
        );
        this.sendJson(res, 200, { result: linked });
        return;
      }
      case 'list_participants': {
        const room = resolveMemberRoom(args.room_id);
        if (!room) {
          this.sendJson(res, 403, { error: 'Forbidden room' });
          return;
        }
        this.sendJson(res, 200, { result: this.serializeRoomDetail(room).participants });
        return;
      }
      default: {
        this.sendJson(res, 404, { error: `Unknown operation '${operation}'` });
      }
    }
  }

  public provisionFromTemplateYaml(
    yamlText: string,
    userParams: Record<string, string> = {},
    creatorUsername = 'priya',
  ): { group: string | null; rooms: SwitchRoomDetail[]; links: SwitchRoomLink[] } {
    const rawDoc = YAML.parse(yamlText) as Record<string, unknown>;
    const resolvedParams: Record<string, string> = {
      $creator: creatorUsername,
      $creator_email: `${creatorUsername}@team.local`,
      $date: new Date().toISOString().slice(0, 10),
      $timestamp: String(Math.floor(Date.now() / 1000)),
      $agents_dir: '/tmp/switch-agents',
    };

    const paramDefs = (rawDoc.params ?? {}) as Record<string, { default?: unknown }>;
    for (const [key, def] of Object.entries(paramDefs)) {
      if (userParams[key] !== undefined) {
        resolvedParams[key] = userParams[key];
      } else if (Array.isArray(def?.default)) {
        const firstChoice = String(def.default[0] ?? '');
        resolvedParams[key] = firstChoice === '$first' ? 'Mattermost' : firstChoice;
      } else if (def?.default !== undefined) {
        resolvedParams[key] = String(def.default);
      }
    }

    const interpolate = (val: string): string =>
      val.replace(/\{(\$?[a-zA-Z0-9_-]+)\}/g, (full, token: string) =>
        resolvedParams[token] !== undefined ? resolvedParams[token] : full,
      );

    const groupBlock = rawDoc.group as { name?: string } | undefined;
    const groupName = groupBlock?.name ? interpolate(groupBlock.name) : null;

    const rawRooms = Array.isArray(rawDoc.rooms)
      ? (rawDoc.rooms as Array<Record<string, unknown>>)
      : rawDoc.room
        ? [rawDoc.room as Record<string, unknown>]
        : [];

    const createdRooms: InternalRoomState[] = [];
    const pendingKickoffs: Array<{ room: InternalRoomState; text: string }> = [];

    for (const r of rawRooms) {
      const name = interpolate(String(r.name ?? 'room'));
      const existing = this.roomsByName.get(name);
      if (existing) {
        createdRooms.push(existing);
        continue;
      }

      const id = `room_${name.replace(/[^a-z0-9]/gi, '_').toLowerCase()}`;
      const aliases: Record<string, string> = {};
      for (const [k, v] of Object.entries((r.aliases ?? {}) as Record<string, string>)) {
        aliases[interpolate(k)] = interpolate(v);
      }

      const roles: SwitchRole[] = Array.isArray(r.roles)
        ? (r.roles as Array<Record<string, unknown>>).map((role) => ({
            name: interpolate(String(role.name)),
            instructions: interpolate(String(role.instructions ?? '')),
            exclusive: Boolean(role.exclusive),
            holder_agent_id: null,
            holder_name: null,
            leased_at: null,
          }))
        : [];

      const documents: SwitchRoomDocument[] = Array.isArray(r.docs)
        ? (r.docs as Array<Record<string, unknown>>).map((d) => ({
            name: interpolate(String(d.name)),
            description: interpolate(String(d.description ?? '')),
            instructions: interpolate(String(d.instructions ?? '')),
            content: interpolate(String(d.content ?? '')),
            created_by_agent_id: 'system',
            created_by_name: 'template',
            updated_at: Date.now(),
          }))
        : [];

      const references: SwitchReference[] = Array.isArray(r.references)
        ? (r.references as Array<Record<string, unknown>>).map((ref, idx) => ({
            id: `ref_${idx + 1}_${name}`,
            type: String(ref.type ?? 'url'),
            name: interpolate(String(ref.name ?? `ref-${idx + 1}`)),
            description: interpolate(String(ref.description ?? '')),
            instructions: interpolate(String(ref.instructions ?? '')),
            value: (ref.value as { urls?: string[] }) ?? {},
          }))
        : [];

      const agentNames = new Set<string>(
        Array.isArray(r.agents) ? (r.agents as string[]).map((a) => interpolate(a)) : [],
      );
      const users = new Set<string>(
        Array.isArray(r.users) ? (r.users as string[]).map((u) => interpolate(u)) : [creatorUsername],
      );

      const roomState: InternalRoomState = {
        id,
        name,
        description: interpolate(String(r.description ?? '')),
        instructions: interpolate(String(r.instructions ?? '')),
        bridge: r.bridge ? interpolate(String(r.bridge)) : 'Mattermost',
        channelType:
          r.channel_type === 'channel_private' ? 'channel_private' : 'channel_public',
        groupName,
        aliases,
        roles,
        documents,
        references,
        agentNames,
        users,
        messages: [],
        seq: 0,
      };

      this.roomsById.set(id, roomState);
      this.roomsByName.set(name, roomState);
      createdRooms.push(roomState);

      // Update any already-open `scope=all` connections for member agents
      for (const conn of this.connections.values()) {
        const agent = this.agentsById.get(conn.agentId);
        if (agent && conn.scope === 'all' && agentNames.has(agent.name)) {
          conn.rooms.add(id);
          if (conn.ws.readyState === WebSocket.OPEN) {
            conn.ws.send(
              JSON.stringify({
                type: 'subscription_changed',
                rooms: Array.from(conn.rooms).sort(),
                reason: 'room_created',
              }),
            );
          }
        }
      }

      const kickoffRaw = (r.kickoff ?? rawDoc.kickoff) as string | undefined;
      if (kickoffRaw) {
        pendingKickoffs.push({ room: roomState, text: interpolate(kickoffRaw.trim()) });
      }
    }

    const rawLinks = Array.isArray(rawDoc.links)
      ? (rawDoc.links as Array<{ from: string; to: string; label?: string }>)
      : [];
    for (const l of rawLinks) {
      const fromName = interpolate(l.from);
      const toName = interpolate(l.to);
      const fromRoom = this.roomsByName.get(fromName);
      const toRoom = this.roomsByName.get(toName);
      if (fromRoom && toRoom && fromRoom.id !== toRoom.id) {
        const exists = this.links.some(
          (x) => x.from_room_id === fromRoom.id && x.to_room_id === toRoom.id,
        );
        if (!exists) {
          this.links.push({
            from_room_id: fromRoom.id,
            from_room_name: fromRoom.name,
            to_room_id: toRoom.id,
            to_room_name: toRoom.name,
            label: interpolate(l.label ?? 'linked room'),
          });
        }
      }
    }

    // Post kickoffs on behalf of the human deployer
    for (const k of pendingKickoffs) {
      this.commitMessageToRoom(
        k.room,
        `@switch-user-${creatorUsername}:switch.local`,
        creatorUsername,
        k.text,
        null,
      );
    }

    return {
      group: groupName,
      rooms: createdRooms.map((r) => this.serializeRoomDetail(r)),
      links: [...this.links],
    };
  }

  public commitMessageToRoom(
    room: InternalRoomState,
    senderParticipantId: string,
    senderName: string,
    content: string,
    threadId: string | null,
  ): { seq: number; message_id: string } {
    room.seq += 1;
    const seq = room.seq;
    const messageId = `msg_${room.id}_${seq}_${randomUUID().slice(0, 6)}`;
    const timestamp = Date.now();

    const logEntry: RoomMessageLogEntry = {
      addressed: false,
      sender: senderParticipantId,
      sender_name: senderName,
      message_id: messageId,
      body: content,
      timestamp,
      thread_id: threadId,
      attachments: [],
      seq,
      room_id: room.id,
      room_name: room.name,
    };
    room.messages.push(logEntry);

    // Deliver into each member agent's per-agent event buffer with accurate `addressed` evaluation
    for (const agentName of room.agentNames) {
      const agent = this.agentsByName.get(agentName);
      if (!agent) continue;

      // Never mark an agent's own message as addressing itself (prevents self-loops!)
      const isSelf = agent.participantId === senderParticipantId;
      const alias = room.aliases[agent.name];
      const lowerBody = content.toLowerCase();
      const mentionsName = lowerBody.includes(`@${agent.name.toLowerCase()}`);
      const mentionsAlias = alias ? lowerBody.includes(`@${alias.toLowerCase()}`) : false;
      const addressed = !isSelf && (mentionsName || mentionsAlias);

      const sequence = agent.nextSequence++;
      const frame: SwitchDomainEventFrame<'message'> = {
        event: 'message',
        id: sequence,
        data: {
          type: 'message',
          room_id: room.id,
          bridge_id: room.bridge ? `bridge_${room.bridge.toLowerCase()}` : null,
          channel_type: room.channelType,
          sequence,
          payload: {
            addressed,
            sender: senderParticipantId,
            sender_name: senderName,
            message_id: messageId,
            body: content,
            timestamp,
            thread_id: threadId,
            attachments: [],
            seq,
          },
        },
      };

      agent.eventBuffer.push(frame);
      if (agent.eventBuffer.length > 500) {
        agent.eventBuffer.shift();
      }

      for (const conn of this.connections.values()) {
        if (conn.agentId === agent.id) {
          this.deliverFrameToConnection(conn, frame);
        }
      }
    }

    return { seq, message_id: messageId };
  }

  public getSnapshot(): {
    rooms: Array<SwitchRoomDetail & { messages: RoomMessageLogEntry[] }>;
    links: SwitchRoomLink[];
    agents: Array<{
      id: string;
      name: string;
      displayName: string;
      description: string;
      participantId: string;
      online: boolean;
      cursor: number;
      generation: number | null;
    }>;
  } {
    const rooms = Array.from(this.roomsById.values()).map((r) => ({
      ...this.serializeRoomDetail(r),
      messages: [...r.messages],
    }));

    const agents = Array.from(this.agentsById.values()).map((a) => {
      const liveConns = Array.from(this.connections.values()).filter(
        (c) => c.agentId === a.id && c.ws.readyState === WebSocket.OPEN,
      );
      return {
        id: a.id,
        name: a.name,
        displayName: a.displayName,
        description: a.description,
        participantId: a.participantId,
        online: liveConns.length > 0,
        cursor: liveConns[0]?.cursor ?? 0,
        generation: liveConns[0]?.generation ?? null,
      };
    });

    return { rooms, links: [...this.links], agents };
  }

  private serializeRoomDetail(room: InternalRoomState): SwitchRoomDetail {
    const participants: SwitchParticipant[] = [];
    for (const u of room.users) {
      participants.push({
        participant_id: `@switch-user-${u}:switch.local`,
        name: u,
        display_name: u.charAt(0).toUpperCase() + u.slice(1),
        kind: 'user',
        online: true,
      });
    }
    for (const aName of room.agentNames) {
      const rec = this.agentsByName.get(aName);
      const isOnline = rec
        ? Array.from(this.connections.values()).some(
            (c) => c.agentId === rec.id && c.ws.readyState === WebSocket.OPEN,
          )
        : false;
      participants.push({
        participant_id: rec?.participantId ?? `@switch-agent-${aName}:switch.local`,
        name: aName,
        display_name: rec?.displayName ?? aName,
        kind: 'agent',
        online: isOnline,
      });
    }

    return {
      id: room.id,
      name: room.name,
      description: room.description,
      instructions: room.instructions,
      bridge: room.bridge,
      channel_type: room.channelType,
      group_name: room.groupName,
      aliases: { ...room.aliases },
      roles: room.roles.map((r) => ({ ...r })),
      documents: room.documents.map((d) => ({ ...d })),
      references: room.references.map((ref) => ({ ...ref })),
      links: this.links.filter(
        (l) => l.from_room_id === room.id || l.to_room_id === room.id,
      ),
      participants,
      seq: room.seq,
    };
  }

  private resolveRoom(idOrName: string): InternalRoomState | undefined {
    return this.roomsById.get(idOrName) ?? this.roomsByName.get(idOrName);
  }

  private authenticateAgent(req: IncomingMessage, agentId: string): RegisteredAgentRecord | null {
    const token = this.extractBearer(req);
    const agent = this.agentsById.get(agentId);
    if (!agent || !token || agent.apiKey !== token) return null;
    return agent;
  }

  private extractBearer(req: IncomingMessage): string {
    const header = req.headers.authorization ?? '';
    return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  }

  private async readJsonBody(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const raw = Buffer.concat(chunks).toString('utf8').trim();
    return raw ? JSON.parse(raw) : {};
  }

  private sendJson(res: ServerResponse, status: number, data: unknown): void {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify(data));
  }

  private notifyChange(): void {
    if (this.onStateChange) {
      this.onStateChange();
    }
  }

  private buildOperationsCatalog(): Record<string, { description: string; input_schema: unknown }> {
    const roomScoped = {
      type: 'object',
      properties: { room_id: { type: 'string' } },
      required: ['room_id'],
    };
    return {
      list_rooms: { description: 'List rooms the agent belongs to', input_schema: { type: 'object' } },
      get_room_detail: { description: 'Read room metadata, roles, docs, and links', input_schema: roomScoped },
      connect_to_room: { description: 'Claim room and load full room context', input_schema: roomScoped },
      read_context: { description: 'Read room message history and context', input_schema: roomScoped },
      post_message: { description: 'Post message to a room', input_schema: roomScoped },
      send_targeted_message: { description: 'Address another agent in a room', input_schema: roomScoped },
      assume_role: { description: 'Acquire lease on a room role', input_schema: roomScoped },
      release_role: { description: 'Release lease on a room role', input_schema: roomScoped },
      create_room_document: { description: 'Create a room-scoped document', input_schema: roomScoped },
      update_room_document: { description: 'Update an agent-authored room document', input_schema: roomScoped },
      load_internal_documents: { description: 'Load all room-scoped documents', input_schema: roomScoped },
      list_linked_rooms: { description: 'List directed links attached to this room', input_schema: roomScoped },
      list_participants: { description: 'List users and agents in this room', input_schema: roomScoped },
    };
  }
}
