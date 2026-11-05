/**
 * Switch Agent Protocol — Wire Types & Resource Definitions
 * Matches https://docs.switchagents.ai/switch-rooms/internals/agent-protocol.md
 *         https://docs.switchagents.ai/switch-rooms/internals/agent-connection.md
 *         https://docs.switchagents.ai/switch-rooms/internals/agent-events.md
 */

export type SwitchConnectionModel =
  | 'always_on'
  | 'session_addressable'
  | 'auto_session'
  | 'session_passive';

export interface SwitchIntegrationProfile {
  connection_model: SwitchConnectionModel;
  message_exchange: boolean;
  pre_invocation_mediation: string[];
  post_invocation_mediation: string[];
  event_reporting: string[];
  command_capabilities?: string[];
}

export interface RegisterAgentRequest {
  name: string;
  description: string;
  connector_type: string;
  integration_profile: SwitchIntegrationProfile;
  display_name?: string;
  icon_url?: string;
  tools?: string[];
  models?: string[];
  metadata?: Record<string, unknown>;
  overwrite?: boolean;
}

export interface RegisterAgentResponse {
  id: string;
  api_key: string;
}

export interface SwitchAttachmentRef {
  filename: string;
  mimetype: string;
  size: number;
  mxc: string;
  msgtype: string;
}

export interface SwitchMessagePayload {
  addressed: boolean;
  sender: string;
  sender_name: string;
  message_id: string;
  body: string;
  timestamp: number;
  thread_id: string | null;
  attachments: SwitchAttachmentRef[];
  seq?: number;
}

export interface SwitchCommandPayload {
  command: string;
  args: string;
  user_id: string;
  user_name: string;
  thread_id: string | null;
}

export interface SwitchRoomJoinPayload {
  member: string;
  member_name: string;
  timestamp: number;
  listening: boolean;
}

export type SwitchDomainEventKind = 'message' | 'command' | 'room_join';

export interface SwitchDomainEventData<K extends SwitchDomainEventKind = SwitchDomainEventKind> {
  type: K;
  room_id: string;
  bridge_id: string | null;
  channel_type: 'channel_public' | 'channel_private' | null;
  payload: K extends 'message'
    ? SwitchMessagePayload
    : K extends 'command'
      ? SwitchCommandPayload
      : SwitchRoomJoinPayload;
  sequence: number;
}

export interface SwitchDomainEventFrame<K extends SwitchDomainEventKind = SwitchDomainEventKind> {
  event: K;
  data: SwitchDomainEventData<K>;
  id: number;
}

export interface SwitchConnectionStateFrame {
  type: 'connection_state';
  connection_id: string;
  agent_id: string;
  generation: number;
  scope: 'single' | 'all';
  filter: 'all' | 'addressed';
  spawn_capable: boolean;
  rooms: string[];
  cursor: number;
  protocol?: number;
  heartbeat_interval_seconds: number;
  server?: Record<string, unknown>;
  client?: Record<string, unknown>;
}

export interface SwitchPingFrame {
  type: 'ping';
}

export interface SwitchPongFrame {
  type: 'pong';
  cursor: number;
}

export interface SwitchGapFrame {
  type: 'gap';
  from_sequence: number;
  resumed_at: number;
  resumed_position?: number;
  rooms: string[];
  all_rooms: boolean;
  reason: string;
}

export type SwitchEvictionCode =
  | 'taken_over'
  | 'heartbeat_lapsed'
  | 'no_stream'
  | 'unfenced'
  | 'connection_error'
  | 'closed';

export interface SwitchEvictedFrame {
  type: 'evicted';
  code: SwitchEvictionCode;
  reason?: string;
}

export interface SwitchSubscriptionChangedFrame {
  type: 'subscription_changed';
  rooms: string[];
  reason: string;
}

export interface SwitchRoomReleasedFrame {
  type: 'room_released';
  room_id: string;
  session_id: string | null;
}

export interface SwitchRefusedFrame {
  type: 'refused';
  status: number;
  detail: string;
}

export type SwitchControlFrame =
  | SwitchConnectionStateFrame
  | SwitchPingFrame
  | SwitchGapFrame
  | SwitchEvictedFrame
  | SwitchSubscriptionChangedFrame
  | SwitchRoomReleasedFrame
  | SwitchRefusedFrame;

export type SwitchIncomingFrame = SwitchDomainEventFrame | SwitchControlFrame;

export interface SwitchRole {
  name: string;
  instructions: string;
  exclusive: boolean;
  holder_agent_id?: string | null;
  holder_name?: string | null;
  leased_at?: number | null;
}

export interface SwitchRoomDocument {
  name: string;
  description: string;
  instructions: string;
  content: string;
  created_by_agent_id: string;
  created_by_name: string;
  updated_at: number;
}

export interface SwitchReference {
  id: string;
  type: string;
  name: string;
  description: string;
  instructions: string;
  value: { urls?: string[]; [key: string]: unknown };
}

export interface SwitchRoomLink {
  from_room_id: string;
  from_room_name: string;
  to_room_id: string;
  to_room_name: string;
  label: string;
}

export interface SwitchParticipant {
  participant_id: string;
  name: string;
  display_name: string;
  kind: 'agent' | 'user' | 'bridge' | 'admin';
  online?: boolean;
}

export interface SwitchRoomDetail {
  id: string;
  name: string;
  description: string;
  instructions: string;
  bridge: string | null;
  channel_type: 'channel_public' | 'channel_private';
  group_name?: string | null;
  aliases: Record<string, string>;
  roles: SwitchRole[];
  documents: SwitchRoomDocument[];
  references: SwitchReference[];
  links: SwitchRoomLink[];
  participants: SwitchParticipant[];
  seq: number;
}

export interface ProtocolWireTrace {
  id: string;
  timestamp: number;
  agentId: string;
  agentName: string;
  direction: 'inbound' | 'outbound' | 'http_op';
  frameType: string;
  summary: string;
  payload: unknown;
}
