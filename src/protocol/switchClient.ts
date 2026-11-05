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
          parsed = JSON.parse(raw.toString()) as SwitchIncomingFrame;
        } catch {
          return;
        }

        // 1. LIVENESS FIRST: Answer every `ping` synchronously before any slow event work!
        if ('type' in parsed && parsed.type === 'ping') {
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
    // Cursors only move forward monotonically
    if (frame.id > this.cursor) {
      this.cursor = frame.id;
    }

    if (frame.event === 'message') {
      const msgData = frame.data as SwitchDomainEventFrame<'message'>['data'];
      const payload = msgData.payload as SwitchMessagePayload;
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
    if (this.reconnectTimer || this.stoppedPermanently || this.closingIntentionally) {
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

  public async connectToRoom(roomId: string): Promise<SwitchRoomDetail> {
    return this.callOperation<SwitchRoomDetail>('connect_to_room', { room_id: roomId });
  }

  public async getRoomDetail(roomId: string): Promise<SwitchRoomDetail> {
    return this.callOperation<SwitchRoomDetail>('get_room_detail', { room_id: roomId });
  }

  public async listRooms(): Promise<SwitchRoomDetail[]> {
    return this.callOperation<SwitchRoomDetail[]>('list_rooms', {});
  }

  public async readContext(roomId: string, limit = 25): Promise<{
    room: SwitchRoomDetail;
    messages: Array<SwitchMessagePayload & { seq: number }>;
  }> {
    return this.callOperation('read_context', { room_id: roomId, limit });
  }

  public async postMessage(roomId: string, content: string, threadId?: string): Promise<{ seq: number; message_id: string }> {
    const args: Record<string, unknown> = { room_id: roomId, content };
    if (threadId) args.thread_id = threadId;
    return this.callOperation('post_message', args);
  }

  public async sendTargetedMessage(
    roomId: string,
    targetAgent: string,
    content: string,
  ): Promise<{ seq: number; message_id: string }> {
    return this.callOperation('send_targeted_message', {
      room_id: roomId,
      target_agent: targetAgent,
      content,
    });
  }

  public async assumeRole(roomId: string, roleName: string): Promise<SwitchRole> {
    return this.callOperation<SwitchRole>('assume_role', { room_id: roomId, role_name: roleName });
  }

  public async releaseRole(roomId: string, roleName: string): Promise<{ released: boolean }> {
    return this.callOperation<{ released: boolean }>('release_role', {
      room_id: roomId,
      role_name: roleName,
    });
  }

  public async createRoomDocument(
    roomId: string,
    doc: { name: string; description: string; instructions: string; content: string },
  ): Promise<SwitchRoomDocument> {
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
    return this.callOperation<SwitchRoomDocument>('update_room_document', {
      room_id: roomId,
      name,
      content,
    });
  }

  public async loadInternalDocuments(roomId: string): Promise<SwitchRoomDocument[]> {
    return this.callOperation<SwitchRoomDocument[]>('load_internal_documents', { room_id: roomId });
  }

  public async listLinkedRooms(roomId: string): Promise<SwitchRoomLink[]> {
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
