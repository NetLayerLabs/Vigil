import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import {
  ProtocolWireTrace,
  RegisterAgentRequest,
  RegisterAgentResponse,
  SwitchControlFrame,
  SwitchDomainEventFrame,
  SwitchEvictedFrame,
  SwitchGapFrame,
  SwitchIncomingFrame,
  SwitchMessagePayload,
  SwitchPongFrame,
  SwitchRole,
  SwitchRoomDetail,
  SwitchRoomDocument,
  SwitchRoomLink,
} from './types.js';

/** Control frames. switch-core wraps them as `{event, data}`; Vigil's embedded server sends `{type, ...}`. */
const CONTROL_EVENTS = new Set([
  'connection_state',
  'ping',
  'gap',
  'evicted',
  'subscription_changed',
  'room_released',
  'refused',
]);

/** A document as switch-core lists it in `connect_to_room` (no content). */
interface CoreDocumentRef {
  id: string;
  name: string;
  description?: string;
  instructions?: string;
}

/** A message inside switch-core's `read_context` threads. */
interface CoreContextMessage {
  id: string;
  kind: string;
  sender: string;
  sender_name: string;
  body: string;
  timestamp: number;
  attachments?: unknown[];
  sender_kind?: string | null;
}

export interface SwitchAgentClientOptions {
  baseUrl: string;
  agentId: string;
  agentName: string;
  apiKey: string;
  connectionId?: string;
  scope?: 'single' | 'all';
  filter?: 'all' | 'addressed';
  rooms?: string[];
  clientName?: string;
  clientVersion?: string;
  onTrace?: (trace: ProtocolWireTrace) => void;
  reconnectDelayMs?: number;
  /** Resume from a known cursor (failover / standby takeover) instead of `head`. */
  initialCursor?: number;
}

export type MessageEventHandler = (
  event: SwitchDomainEventFrame<'message'>['data'] & { payload: SwitchMessagePayload },
  meta: { hadGapBeforeEvent: boolean },
) => Promise<void> | void;

/**
 * Spec-Compliant Switch WebSocket + HTTP Agent Protocol Client
 *
 * Implements:
 * - WebSocket transport `/agents/{agent_id}/connection/ws` with Bearer auth
 * - Immediate 2s `ping` -> `{"type":"pong","cursor":n}` liveness responder (never blocked by handlers)
 * - Generation fencing (`expected_generation` + `start_from`) across reconnects
 * - Terminal halt on `evicted` with `code === 'taken_over'`
 * - Gap holding (`resumed_at` cursor advance + context refresh notification)
 * - Dynamic operation discovery (`GET /agents/{id}/ops`) and `X-Switch-Connection-Id` calls
 */
export class SwitchAgentClient {
  public readonly baseUrl: string;
  public readonly agentId: string;
  public readonly agentName: string;
  public readonly connectionId: string;

  private readonly apiKey: string;
  private readonly scope: 'single' | 'all';
  private readonly filter: 'all' | 'addressed';
  private readonly initialRooms: string[];
  private readonly clientName: string;
  private readonly clientVersion: string;
  private readonly onTrace?: (trace: ProtocolWireTrace) => void;
  private readonly reconnectDelayMs: number;

  private ws: WebSocket | null = null;
  private cursor = 0;
  private generation: number | undefined;
  private coveredRooms: string[] = [];
  private pendingGap: SwitchGapFrame | null = null;
  private stoppedPermanently = false;
  private closingIntentionally = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private messageHandlers: MessageEventHandler[] = [];
  private discoveredOps: Record<string, { description: string; input_schema: unknown }> = {};
  /** Chaos flag: a hung client keeps its socket open but stops answering pings and ignores events. */
  private hung = false;
  /**
   * Which server this client talks to. Vigil's embedded protocol server takes a `room_id` on every
   * operation. A real Switch server (switch-core) binds operations to the room the connection last
   * joined with `connect_to_room`, wraps control frames as `{event, data}`, and names some arguments
   * differently. Detected from the first `connection_state` frame.
   */
  private dialect: 'embedded' | 'switch-core' = 'embedded';
  /** switch-core: the room this connection is bound to, and a queue so room-bound ops never interleave. */
  private boundRoomId: string | null = null;
  private roomChain: Promise<unknown> = Promise.resolve();

  constructor(opts: SwitchAgentClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.agentId = opts.agentId;
    this.agentName = opts.agentName;
    this.apiKey = opts.apiKey;
    this.connectionId = opts.connectionId ?? randomUUID();
    this.scope = opts.scope ?? 'all';
    this.filter = opts.filter ?? 'all';
    this.initialRooms = opts.rooms ?? [];
    this.clientName = opts.clientName ?? 'vigil-switch-sdk';
    this.clientVersion = opts.clientVersion ?? '1.0.0';
    this.onTrace = opts.onTrace;
    this.reconnectDelayMs = opts.reconnectDelayMs ?? 750;
    this.cursor = Math.max(0, opts.initialCursor ?? 0);
  }

  /**
   * Chaos hook: simulate a wedged agent process. The WebSocket stays open but the client stops
   * answering `ping` and ignores events, so the server either evicts it on heartbeat lapse or a
   * standby reopening the same `connection_id` takes it over (`evicted: taken_over`).
   */
  public simulateHang(): void {
    this.hung = true;
    this.emitTrace('outbound', 'chaos:hang', 'Client wedged: pings unanswered, events ignored', {});
  }

  public isHung(): boolean {
    return this.hung;
  }

  /** True while the WebSocket is open and the client is answering (not wedged, not evicted). */
  public isConnected(): boolean {
    return !this.hung && !this.stoppedPermanently && this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

    /** True once the server has identified itself as a real Switch server (switch-core). */
  public isSwitchCore(): boolean {
    return this.dialect === 'switch-core';
  }

  /**
   * Out-of-band one-time registration (`POST /agents` with Registration Key).
   */
  public static async registerAgent(
    baseUrl: string,
    registrationKey: string,
    spec: RegisterAgentRequest,
  ): Promise<RegisterAgentResponse> {
    const cleanUrl = baseUrl.replace(/\/+$/, '');
    const res = await fetch(`${cleanUrl}/agents`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${registrationKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(spec),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Switch agent registration failed (${res.status}): ${body}`);
    }
    return (await res.json()) as RegisterAgentResponse;
  }

  /**
   * Probe `GET /health` (public, skips bearer check) to verify Switch bridge base URL.
   */
  public static async checkHealth(baseUrl: string): Promise<boolean> {
    try {
      const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/health`);
      return res.ok;
    } catch {
      return false;
    }
  }

  public getCursor(): number {
    return this.cursor;
  }

  public getGeneration(): number | undefined {
    return this.generation;
  }

  public getCoveredRooms(): string[] {
    return [...this.coveredRooms];
  }

  public isStoppedPermanently(): boolean {
    return this.stoppedPermanently;
  }

  public onAddressedMessage(handler: MessageEventHandler): void {
    this.messageHandlers.push(handler);
  }

  /**
   * Discover available Switch operations dynamically (`GET /agents/{agent_id}/ops`).
   */
  public async discoverOperations(): Promise<Record<string, { description: string; input_schema: unknown }>> {
    const res = await fetch(`${this.baseUrl}/agents/${encodeURIComponent(this.agentId)}/ops`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
      },
    });
    if (!res.ok) {
      throw new Error(`Failed to discover operations (${res.status}): ${await res.text()}`);
    }
    const data = (await res.json()) as {
      operations: Record<string, { description: string; input_schema: unknown }>;
    };
    this.discoveredOps = data.operations ?? {};
    return this.discoveredOps;
  }

  /**
   * Open the WebSocket connection and wait for the initial `connection_state` frame.
   */
  public async connect(): Promise<void> {
    if (this.stoppedPermanently) {
      throw new Error(`Connection ${this.connectionId} was permanently evicted (taken_over) and must not reconnect.`);
    }
    this.closingIntentionally = false;
    await this.openSocket(true);
  }

  private openSocket(isInitialAwait = false): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const wsBase = this.baseUrl.replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:');
      const params = new URLSearchParams({
        connection_id: this.connectionId,
        scope: this.scope,
        filter: this.filter,
        start_from: this.cursor > 0 ? String(this.cursor) : 'head',
        client: this.clientName,
        client_version: this.clientVersion,
      });

      if (this.initialRooms.length > 0) {
        params.set('rooms', this.initialRooms.join(','));
      }
      if (this.generation !== undefined) {
        params.set('expected_generation', String(this.generation));
      }

      const wsUrl = `${wsBase}/agents/${encodeURIComponent(this.agentId)}/connection/ws?${params.toString()}`;
      const socket = new WebSocket(wsUrl, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
        },
      });
      this.ws = socket;

      socket.on('message', (raw) => {
        let parsed: SwitchIncomingFrame;
        try {
          parsed = this.normalizeFrame(JSON.parse(raw.toString()));
        } catch {
          return;
        }

        // 1. LIVENESS FIRST: Answer every `ping` synchronously before any slow event work!
        if ('type' in parsed && parsed.type === 'ping') {
          if (this.hung) {
            this.emitTrace('inbound', 'ping', `Server ping ignored (client hung, cursor=${this.cursor})`, parsed);
            return;
          }
          const pong: SwitchPongFrame = { type: 'pong', cursor: this.cursor };
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify(pong));
          }
          this.emitTrace('inbound', 'ping', `Server heartbeat ping (cursor=${this.cursor})`, parsed);
          this.emitTrace('outbound', 'pong', `Client pong ack (cursor=${this.cursor})`, pong);
          return;
        }

        // 2. Control frames (`connection_state`, `gap`, `evicted`, `subscription_changed`, `refused`, `room_released`)
        if ('type' in parsed) {
          this.handleControlFrame(parsed, () => {
            if (!settled) {
              settled = true;
              resolve();
            }
          }, (err) => {
            if (!settled) {
              settled = true;
              reject(err);
            }
          });
          return;
        }

        // 3. Domain event frames (`message`, `command`, `room_join`)
        if ('event' in parsed && typeof parsed.id === 'number') {
          this.handleDomainFrame(parsed);
        }
      });

      socket.on('error', (err) => {
        if (isInitialAwait && !settled) {
          settled = true;
          reject(err);
        }
      });

      socket.on('close', (code) => {
        if (isInitialAwait && !settled) {
          settled = true;
          reject(new Error(`Switch WebSocket closed before connection_state (code=${code})`));
          return;
        }
        if (this.closingIntentionally || this.stoppedPermanently) {
          return;
        }
        // Close codes 4401 / 4403 / 4400 are permanent auth/config errors
        if (code === 4401 || code === 4403 || code === 4400) {
          this.stoppedPermanently = true;
          return;
        }
        this.scheduleReconnect();
      });
    });
  }

  private handleControlFrame(
    frame: SwitchControlFrame,
    onReady: () => void,
    onRefused: (err: Error) => void,
  ): void {
    switch (frame.type) {
      case 'connection_state': {
        // A fresh attachment: re-bind to a room before the next room-scoped operation.
        this.boundRoomId = null;
        this.generation = frame.generation;
        this.coveredRooms = [...frame.rooms];
        if (frame.cursor > this.cursor) {
          this.cursor = frame.cursor;
        }
        this.emitTrace(
          'inbound',
          'connection_state',
          `Attached gen=${frame.generation} cursor=${this.cursor} rooms=[${frame.rooms.join(',')}]`,
          frame,
        );
        onReady();
        break;
      }
      case 'gap': {
        if (frame.resumed_at > this.cursor) {
          this.cursor = frame.resumed_at;
        }
        this.pendingGap = frame;
        this.emitTrace(
          'inbound',
          'gap',
          `Cursor gap (${frame.reason}), advanced cursor -> ${this.cursor}`,
          frame,
        );
        break;
      }
      case 'evicted': {
        this.handleEviction(frame);
        break;
      }
      case 'subscription_changed': {
        this.coveredRooms = [...frame.rooms];
        this.emitTrace(
          'inbound',
          'subscription_changed',
          `Covered rooms updated (${frame.reason}): [${frame.rooms.join(',')}]`,
          frame,
        );
        break;
      }
      case 'room_released': {
        this.coveredRooms = this.coveredRooms.filter((r) => r !== frame.room_id);
        this.emitTrace('inbound', 'room_released', `Room released: ${frame.room_id}`, frame);
        break;
      }
      case 'refused': {
        this.emitTrace('inbound', 'refused', `Refused (${frame.status}): ${frame.detail}`, frame);
        if (frame.detail.includes('taken_over') || frame.detail.includes('managed_by_controller')) {
          this.stoppedPermanently = true;
        }
        onRefused(new Error(`Switch connection refused (${frame.status}): ${frame.detail}`));
        break;
      }
    }
  }

  /** switch-core sends control frames as `{event, data}`; fold them into the `{type, ...}` shape. */
  private normalizeFrame(raw: unknown): SwitchIncomingFrame {
    const f = raw as { type?: unknown; event?: unknown; data?: Record<string, unknown>; id?: unknown };
    if (
      f &&
      typeof f === 'object' &&
      f.type === undefined &&
      typeof f.event === 'string' &&
      CONTROL_EVENTS.has(f.event) &&
      typeof f.id !== 'number'
    ) {
      this.dialect = 'switch-core';
      return { type: f.event, ...(f.data ?? {}) } as SwitchControlFrame;
    }
    return raw as SwitchIncomingFrame;
  }

  private handleEviction(frame: SwitchEvictedFrame): void {
    this.emitTrace('inbound', 'evicted', `Evicted code=${frame.code} (${frame.reason ?? ''})`, frame);
    if (frame.code === 'taken_over') {
      // Spec invariant: `taken_over` is final — never reconnect or two clients fight forever!
      this.stoppedPermanently = true;
      return;
    }
    if (frame.code === 'closed') {
      const permanentReasons = ['deleted', 'managed_by_controller'];
      if (permanentReasons.some((r) => (frame.reason ?? '').includes(r))) {
        this.stoppedPermanently = true;
        return;
      }
    }
  }

  private handleDomainFrame(frame: SwitchDomainEventFrame): void {
    if (this.hung) return;
    // Cursors only move forward monotonically
    if (frame.id > this.cursor) {
      this.cursor = frame.id;
    }

    if (frame.event === 'message') {
      const msgData = frame.data as SwitchDomainEventFrame<'message'>['data'];
      const payload = msgData.payload as SwitchMessagePayload;
      if (payload.sender_kind == null) payload.sender_kind = senderKindFromId(payload.sender);
      this.emitTrace(
        'inbound',
        'message',
        `[seq=${frame.id}] ${payload.sender_name} in ${msgData.room_id} (addressed=${payload.addressed}): ${payload.body.slice(0, 72)}`,
        frame,
      );

      // Spec invariant: Act on a `message` event ONLY when `payload.addressed` is true!
      if (!payload.addressed) {
        return;
      }

      const hadGapBeforeEvent = this.pendingGap !== null;
      this.pendingGap = null;

      for (const handler of this.messageHandlers) {
        Promise.resolve(handler({ ...msgData, payload }, { hadGapBeforeEvent })).catch((err) => {
          console.error(`[SwitchAgentClient:${this.agentName}] handler error:`, err);
        });
      }
    } else {
      this.emitTrace('inbound', frame.event, `Domain event ${frame.event} (id=${frame.id})`, frame);
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.stoppedPermanently || this.closingIntentionally || this.hung) {
      return;
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.stoppedPermanently && !this.closingIntentionally) {
        this.openSocket(false).catch(() => {
          this.scheduleReconnect();
        });
      }
    }, this.reconnectDelayMs);
  }

  public async disconnect(): Promise<void> {
    this.closingIntentionally = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      const socket = this.ws;
      this.ws = null;
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        await new Promise<void>((resolve) => {
          socket.once('close', () => resolve());
          socket.close(1000, 'client_disconnect');
        });
      }
    }
  }

  /**
   * Call a Switch operation (`POST /agents/{agent_id}/ops/{operation}`)
   * with `X-Switch-Connection-Id` and unwrapped JSON arguments.
   */
  public async callOperation<T = unknown>(
    operation: string,
    args: Record<string, unknown> = {},
  ): Promise<T> {
    this.emitTrace('http_op', `op:${operation}`, `POST /ops/${operation}`, args);
    const res = await fetch(
      `${this.baseUrl}/agents/${encodeURIComponent(this.agentId)}/ops/${encodeURIComponent(operation)}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          'X-Switch-Connection-Id': this.connectionId,
        },
        body: JSON.stringify(args),
      },
    );

    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`Switch operation '${operation}' failed (${res.status}): ${detail}`);
    }

    const body = (await res.json()) as { result: T };
    return body.result;
  }

  // ---- Typed Convenience Wrappers over the Switch Operation Catalog ----
  //
  // Each wrapper speaks both dialects. On switch-core, room-scoped operations run inside `inRoom`,
  // which binds the connection with `connect_to_room` first and queues them so two rooms never
  // interleave on one connection. Responses are mapped back to Vigil's own types.

  /** Run `fn` with this connection bound to `roomId` (switch-core). Calls are serialized per client. */
  private inRoom<T>(roomId: string, fn: () => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      if (this.boundRoomId !== roomId) {
        await this.describeRoom(roomId);
      }
      return fn();
    };
    const next = this.roomChain.then(run, run);
    this.roomChain = next.catch(() => undefined);
    return next;
  }

  /** `connect_to_room`: binds the connection and returns the room as switch-core describes it. */
  private async describeRoom(roomId: string): Promise<{
    documents?: CoreDocumentRef[];
    [key: string]: unknown;
  }> {
    const detail = await this.callOperation<{ documents?: CoreDocumentRef[] }>('connect_to_room', {
      room_id: roomId,
      include_general_instructions: false,
    });
    this.boundRoomId = roomId;
    return detail;
  }

  public async connectToRoom(roomId: string): Promise<SwitchRoomDetail> {
    if (this.dialect === 'switch-core') {
      return this.inRoom(roomId, async () => (await this.describeRoom(roomId)) as unknown as SwitchRoomDetail);
    }
    return this.callOperation<SwitchRoomDetail>('connect_to_room', { room_id: roomId });
  }

  public async getRoomDetail(roomId: string): Promise<SwitchRoomDetail> {
    return this.callOperation<SwitchRoomDetail>('get_room_detail', { room_id: roomId });
  }

  public async listRooms(includeArchived = false): Promise<SwitchRoomDetail[]> {
    if (this.dialect === 'switch-core') {
      const rooms = await this.callOperation<Array<{ room_id: string; name: string; archived?: boolean }>>(
        'list_rooms',
        includeArchived ? { include_archived: true } : {},
      );
      return rooms.map((r) => ({ ...r, id: r.room_id }) as unknown as SwitchRoomDetail);
    }
    return this.callOperation<SwitchRoomDetail[]>('list_rooms', {});
  }

  public async readContext(roomId: string, limit = 25): Promise<{
    room: SwitchRoomDetail;
    messages: Array<SwitchMessagePayload & { seq: number }>;
  }> {
    if (this.dialect === 'switch-core') {
      const ctx = await this.callOperation<{
        threads?: Array<{ root: CoreContextMessage; replies?: CoreContextMessage[] }>;
      }>('read_context', { room_id: roomId, limit });
      const messages: Array<SwitchMessagePayload & { seq: number }> = [];
      for (const thread of ctx.threads ?? []) {
        for (const m of [thread.root, ...(thread.replies ?? [])]) {
          if (!m || m.kind !== 'message') continue;
          messages.push({
            addressed: false,
            sender: m.sender,
            sender_name: m.sender_name,
            sender_kind: m.sender_kind ?? senderKindFromId(m.sender),
            message_id: m.id,
            body: m.body,
            timestamp: m.timestamp,
            thread_id: m === thread.root ? null : thread.root.id,
            attachments: [],
            seq: 0,
          });
        }
      }
      messages.sort((a, b) => a.timestamp - b.timestamp);
      return { room: { id: roomId } as SwitchRoomDetail, messages };
    }
    return this.callOperation('read_context', { room_id: roomId, limit });
  }

  public async postMessage(roomId: string, content: string, threadId?: string): Promise<{ seq: number; message_id: string }> {
    if (this.dialect === 'switch-core') {
      return this.inRoom(roomId, () =>
        this.callOperation('post_message', threadId ? { body: content, thread_id: threadId } : { body: content }),
      );
    }
    const args: Record<string, unknown> = { room_id: roomId, content };
    if (threadId) args.thread_id = threadId;
    return this.callOperation('post_message', args);
  }

  public async sendTargetedMessage(
    roomId: string,
    targetAgent: string,
    content: string,
  ): Promise<{ seq: number; message_id: string }> {
    if (this.dialect === 'switch-core') {
      // switch-core prefixes the mention itself; drop ours so it is not doubled.
      const mention = new RegExp(`^\\s*@${targetAgent.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b\\s*`, 'i');
      const body = content.replace(mention, '');
      return this.inRoom(roomId, () =>
        this.callOperation('send_targeted_message', { body, target_names: [targetAgent] }),
      );
    }
    return this.callOperation('send_targeted_message', {
      room_id: roomId,
      target_agent: targetAgent,
      content,
    });
  }

  public async assumeRole(roomId: string, roleName: string): Promise<SwitchRole> {
    if (this.dialect === 'switch-core') {
      return this.inRoom(roomId, () => this.callOperation<SwitchRole>('assume_role', { role: roleName }));
    }
    return this.callOperation<SwitchRole>('assume_role', { room_id: roomId, role_name: roleName });
  }

  public async releaseRole(roomId: string, roleName: string): Promise<{ released: boolean }> {
    if (this.dialect === 'switch-core') {
      // switch-core releases whichever role this agent holds in the bound room.
      await this.inRoom(roomId, () => this.callOperation('release_role', {}));
      return { released: true };
    }
    return this.callOperation<{ released: boolean }>('release_role', {
      room_id: roomId,
      role_name: roleName,
    });
  }

  /** Create a room document, or replace its content when one with that name already exists. */
  public async createRoomDocument(
    roomId: string,
    doc: { name: string; description: string; instructions: string; content: string },
  ): Promise<SwitchRoomDocument> {
    if (this.dialect === 'switch-core') {
      return this.inRoom(roomId, async () => {
        const room = await this.describeRoom(roomId);
        const existing = (room.documents ?? []).find((d) => d.name === doc.name);
        if (existing) {
          return this.callOperation<SwitchRoomDocument>('update_room_document', {
            document_id: existing.id,
            ...doc,
          });
        }
        return this.callOperation<SwitchRoomDocument>('create_room_document', doc);
      });
    }
    return this.callOperation<SwitchRoomDocument>('create_room_document', {
      room_id: roomId,
      ...doc,
    });
  }

  public async updateRoomDocument(
    roomId: string,
    name: string,
    content: string,
  ): Promise<SwitchRoomDocument> {
    if (this.dialect === 'switch-core') {
      return this.inRoom(roomId, async () => {
        const room = await this.describeRoom(roomId);
        const existing = (room.documents ?? []).find((d) => d.name === name);
        if (!existing) {
          return this.callOperation<SwitchRoomDocument>('create_room_document', {
            name,
            description: name,
            instructions: name,
            content,
          });
        }
        return this.callOperation<SwitchRoomDocument>('update_room_document', {
          document_id: existing.id,
          content,
        });
      });
    }
    return this.callOperation<SwitchRoomDocument>('update_room_document', {
      room_id: roomId,
      name,
      content,
    });
  }

  public async loadInternalDocuments(roomId: string): Promise<SwitchRoomDocument[]> {
    if (this.dialect === 'switch-core') {
      return this.inRoom(roomId, async () => {
        const room = await this.describeRoom(roomId);
        const ids = (room.documents ?? []).map((d) => d.id);
        if (ids.length === 0) return [];
        return this.callOperation<SwitchRoomDocument[]>('load_internal_documents', { ids });
      });
    }
    return this.callOperation<SwitchRoomDocument[]>('load_internal_documents', { room_id: roomId });
  }

  /**
   * Set who may address an agent (`anyone` lets any human teammate and any agent instruct it).
   * switch-core refuses an agent changing its own setting, so pass a sibling agent's id there: an
   * agent may change another agent its owner owns. The embedded server takes the caller's own id.
   */
  public async updateAddressing(
    addressing: 'owner_only' | 'owner_and_owner_agents' | 'anyone',
    targetAgentId: string = this.agentId,
  ): Promise<unknown> {
    return this.callOperation('update_agent_detail', { agent_id: targetAgentId, addressing });
  }

  /**
   * Provision rooms from a Switch room template (`create_room_from_yaml`, switch-core). Returns the
   * rooms created, with their ids.
   */
  public async createRoomsFromYaml(
    yaml: string,
    inputs: Record<string, unknown>,
  ): Promise<Array<{ id: string; name: string }>> {
    const result = await this.callOperation<{
      room_id?: string;
      room_name?: string;
      rooms?: Array<{ room_id: string; room_name: string }>;
      errors?: unknown[];
    }>('create_room_from_yaml', { yaml, inputs });
    if (Array.isArray(result.errors) && result.errors.length > 0) {
      throw new Error(`create_room_from_yaml reported errors: ${JSON.stringify(result.errors)}`);
    }
    const rooms = result.rooms ?? (result.room_id ? [{ room_id: result.room_id, room_name: result.room_name ?? '' }] : []);
    return rooms.map((r) => ({ id: r.room_id, name: r.room_name }));
  }

  public async createRoom(input: {
    name: string;
    description?: string;
    instructions?: string;
    bridge?: string | null;
    channel_type?: 'channel_public' | 'channel_private';
    agents?: string[];
    users?: string[];
    roles?: Array<{ name: string; instructions: string; exclusive: boolean }>;
    documents?: Array<{ name: string; description: string; instructions: string; content: string }>;
  }): Promise<SwitchRoomDetail> {
    if (this.dialect === 'switch-core') {
      const created = await this.callOperation<{ id?: string; room_id?: string; name?: string }>('create_room', {
        name: input.name,
        description: input.description ?? input.name,
        instructions: input.instructions,
        channel_type: input.channel_type,
        agent_names: input.agents ?? [this.agentName],
        user_names: input.users,
        roles: input.roles,
      });
      const id = created.id ?? created.room_id ?? '';
      for (const doc of input.documents ?? []) {
        await this.createRoomDocument(id, doc);
      }
      return { ...created, id, name: created.name ?? input.name } as unknown as SwitchRoomDetail;
    }
    return this.callOperation<SwitchRoomDetail>('create_room', input);
  }

  public async linkRooms(fromRoomId: string, toRoomId: string, label: string): Promise<SwitchRoomLink> {
    if (this.dialect === 'switch-core') {
      return this.callOperation<SwitchRoomLink>('link_rooms', {
        source_room_id: fromRoomId,
        target_room_id: toRoomId,
        label,
      });
    }
    return this.callOperation<SwitchRoomLink>('link_rooms', {
      from_room_id: fromRoomId,
      to_room_id: toRoomId,
      label,
    });
  }

  public async archiveRoom(roomId: string): Promise<SwitchRoomDetail> {
    return this.callOperation<SwitchRoomDetail>('archive_room', { room_id: roomId });
  }

  public async inviteAgentToRoom(roomId: string, agentName: string): Promise<unknown> {
    return this.callOperation('invite_agent_to_room', { room_id: roomId, agent_name: agentName });
  }

  public async listLinkedRooms(roomId: string): Promise<SwitchRoomLink[]> {
    if (this.dialect === 'switch-core') {
      const links = await this.inRoom(roomId, () =>
        this.callOperation<Array<{ target_room_id: string; target_room_name: string; label: string }>>(
          'list_linked_rooms',
          {},
        ),
      );
      return links.map((l) => ({
        from_room_id: roomId,
        from_room_name: '',
        to_room_id: l.target_room_id,
        to_room_name: l.target_room_name,
        label: l.label,
      }));
    }
    return this.callOperation<SwitchRoomLink[]>('list_linked_rooms', { room_id: roomId });
  }

  private emitTrace(
    direction: ProtocolWireTrace['direction'],
    frameType: string,
    summary: string,
    payload: unknown,
  ): void {
    if (!this.onTrace) return;
    this.onTrace({
      id: randomUUID(),
      timestamp: Date.now(),
      agentId: this.agentId,
      agentName: this.agentName,
      direction,
      frameType,
      summary,
      payload,
    });
  }
}

/**
 * A real Switch server labels only some messages with sender_kind. The participant id still says who
 * spoke: agents are `@switch-agent-*`, people are `@switch-user-*` or on a chat bridge
 * (`@switch-<app>-<bridge>-<handle>`). Anything else stays unknown, and the gate treats unknown as not a person.
 */
export function senderKindFromId(id: string | undefined | null): 'agent' | 'user' | null {
  const lower = (id ?? '').toLowerCase();
  if (lower.startsWith('@switch-agent-')) return 'agent';
  if (/^@switch-(?:user-|admin:|(?:mattermost|slack|discord|telegram|teams)-)/.test(lower)) return 'user';
  return null;
}
