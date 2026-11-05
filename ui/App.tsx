import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Bot,
  CheckCircle2,
  Code2,
  Copy,
  FileText,
  Flame,
  GitCommit,
  Home,
  Lock,
  Network,
  Play,
  Radio,
  RotateCcw,
  Send,
  ShieldAlert,
  ShieldCheck,
  Terminal,
  UserCheck,
  Zap,
} from 'lucide-react';

interface RoomRole {
  name: string;
  instructions: string;
  exclusive: boolean;
  holder_agent_id?: string | null;
  holder_name?: string | null;
}

interface RoomDocument {
  name: string;
  description: string;
  instructions: string;
  content: string;
  created_by_name: string;
  updated_at: number;
}

interface RoomLink {
  from_room_id: string;
  from_room_name: string;
  to_room_id: string;
  to_room_name: string;
  label: string;
}

interface RoomMessage {
  seq: number;
  message_id: string;
  sender: string;
  sender_name: string;
  body: string;
  timestamp: number;
  room_id: string;
  room_name: string;
}

interface SwitchRoom {
  id: string;
  name: string;
  description: string;
  instructions: string;
  bridge: string | null;
  seq: number;
  roles: RoomRole[];
  documents: RoomDocument[];
  links: RoomLink[];
  messages: RoomMessage[];
}

interface SwitchAgentSummary {
  id: string;
  name: string;
  displayName: string;
  description: string;
  online: boolean;
  cursor: number;
  generation: number | null;
}

interface IncidentRecord {
  incidentId: string;
  scenarioId: string;
  title: string;
  stage: string;
  alert: {
    deployedVersion: string;
    lastKnownGoodVersion: string;
    httpStatus: number;
    errorRatePct: number;
    p99LatencyMs: number;
    errorMessage: string;
    suspectedCommit: {
      sha: string;
      author: string;
      message: string;
      filePath: string;
      line: number;
    };
  };
  patchVerification: {
    reproConfirmed: boolean;
    reproErrorOutput: string;
    candidateVersion: string;
    diffUnified: string;
    changedLines: number;
    touchedFiles: string[];
    testMatrix: Array<{ name: string; passed: boolean; detail: string }>;
    allPassed: boolean;
  } | null;
  gateDecisions: Array<{
    allowed: boolean;
    action: string | null;
    reasonCode: string;
    explanation: string;
    senderName: string;
    timestamp: number;
  }>;
  canaryReport: {
    probesRun: number;
    probesPassed: number;
    maxLatencyMs: number;
    healthy: boolean;
    details: string[];
  } | null;
  finalVersion: string | null;
}

interface WireTrace {
  id: string;
  timestamp: number;
  agentName: string;
  direction: 'inbound' | 'outbound' | 'http_op';
  frameType: string;
  summary: string;
}

interface ObservatorySnapshot {
  mode: string;
  switchServerUrl: string;
  checkoutBaseUrl: string;
  checkoutTelemetry: {
    deployedVersion: string;
    lastKnownGoodVersion: string;
    stagedCandidateVersion: string | null;
    totalRequests: number;
    totalErrors: number;
    errorRatePct: number;
    p99LatencyMs: number;
    activeInventoryLocks: number;
    maxInventoryLocks: number;
    status: 'healthy' | 'degraded';
  };
  switchState: {
    rooms: SwitchRoom[];
    links: RoomLink[];
    agents: SwitchAgentSummary[];
  };
  incidents: IncidentRecord[];
  activeIncident: IncidentRecord | null;
  wireTraces: WireTrace[];
  roomIds: {
    incidentsRoomId: string;
    hotfixRoomId: string;
    releasesRoomId: string;
  };
}

export function App({ onHome }: { onHome?: () => void } = {}) {
  const [snap, setSnap] = useState<ObservatorySnapshot | null>(null);
  const [selectedRoomId, setSelectedRoomId] = useState<string>('');
  const [rightTab, setRightTab] = useState<'docs' | 'wire' | 'patch'>('docs');
  const [selectedDocName, setSelectedDocName] = useState<string>('');
  const [chatInput, setChatInput] = useState<string>('');
  const [operatorHandle, setOperatorHandle] = useState<string>('priya');
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [showTemplateModal, setShowTemplateModal] = useState<boolean>(false);
  const [templateYaml, setTemplateYaml] = useState<string>('');
  const [copiedYaml, setCopiedYaml] = useState<boolean>(false);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let active = true;
    fetch('/api/state')
      .then((r) => r.json())
      .then((data: ObservatorySnapshot) => {
        if (!active) return;
        setSnap(data);
        if (!selectedRoomId && data.roomIds.incidentsRoomId) {
          setSelectedRoomId(data.roomIds.incidentsRoomId);
        }
      })
      .catch(() => {});

    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${window.location.host}/ws/observatory`);
    ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data);
        if (msg.type === 'observatory_snapshot' && active) {
          setSnap(msg.data);
          setSelectedRoomId((prev) => prev || msg.data.roomIds?.incidentsRoomId || '');
        }
      } catch {
        // ignore
      }
    };
    return () => {
      active = false;
      ws.close();
    };
  }, []);

  const currentRoom = useMemo(() => {
    if (!snap) return null;
    return (
      snap.switchState.rooms.find((r) => r.id === selectedRoomId) ??
      snap.switchState.rooms[0] ??
      null
    );
  }, [snap, selectedRoomId]);

  const allDocuments = useMemo(() => {
    if (!snap) return [];
    return snap.switchState.rooms.flatMap((r) =>
      r.documents.map((d) => ({ ...d, roomName: r.name, roomId: r.id })),
    );
  }, [snap]);

  const activeDoc = useMemo(() => {
    if (allDocuments.length === 0) return null;
    return allDocuments.find((d) => d.name === selectedDocName) ?? allDocuments[allDocuments.length - 1];
  }, [allDocuments, selectedDocName]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [currentRoom?.messages.length]);

  const injectChaos = async (scenarioId: string) => {
    setBusyAction(scenarioId);
    try {
      await fetch('/api/chaos/inject', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scenarioId }),
      });
      if (snap?.roomIds.incidentsRoomId) {
        setSelectedRoomId(snap.roomIds.incidentsRoomId);
      }
    } finally {
      setBusyAction(null);
    }
  };

  const postChatMessage = async (roomId: string, content: string, customUser?: { username: string; displayName: string }) => {
    if (!content.trim()) return;
    setBusyAction('chat');
    try {
      await fetch('/api/chat/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          roomId,
          username: customUser?.username ?? operatorHandle,
          displayName:
            customUser?.displayName ??
            (operatorHandle === 'priya' ? 'Priya (On-Call Lead)' : `${operatorHandle} (Engineer)`),
          content,
        }),
      });
    } finally {
      setBusyAction(null);
    }
  };

  const handleSendChat = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentRoom || !chatInput.trim()) return;
    const text = chatInput;
    setChatInput('');
    await postChatMessage(currentRoom.id, text);
  };

  const openTemplatesModal = async () => {
    setShowTemplateModal(true);
    if (!templateYaml) {
      const res = await fetch('/api/templates');
      const data = await res.json();
      setTemplateYaml(data.warRoomTemplate ?? '');
    }
  };

  if (!snap) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center text-slate-300">
        <div className="flex items-center gap-3 font-mono text-sm">
          <Radio className="w-5 h-5 text-emerald-400 animate-pulse" />
          Connecting to Vigil Switch Agent Protocol Mesh...
        </div>
      </div>
    );
  }

  const telemetry = snap.checkoutTelemetry;
  const activeInc = snap.activeIncident;
  const latestInc = activeInc ?? snap.incidents[0] ?? null;

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col">
      {/* Top Navigation & Telemetry Header */}
      <header className="border-b border-slate-800/90 bg-slate-900/75 backdrop-blur px-5 py-3 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-emerald-500/15 border border-emerald-500/40 flex items-center justify-center">
            <ShieldCheck className="w-5 h-5 text-emerald-400" />
          </div>
          <div>
            <div className="flex items-center gap-2.5">
              <h1 className="font-semibold tracking-tight text-base text-white">VIGIL</h1>
              <span className="text-[11px] font-mono uppercase px-2 py-0.5 rounded bg-slate-800 text-emerald-300 border border-slate-700">
                Switch War Room Mesh
              </span>
              <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-indigo-500/15 text-indigo-300 border border-indigo-500/30">
                {snap.mode === 'embedded_switch_protocol_server'
                  ? 'Switch WS Protocol v6 · Embedded Bridge'
                  : 'Switch Console · Live Bridge'}
              </span>
            </div>
            <p className="text-xs text-slate-400">
              Autonomous Incident Triage → Surgical Reproduction → Human-Gated Release across Linked Switch Rooms
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          <div
            className={`px-3 py-1.5 rounded-lg border text-xs font-mono flex items-center gap-2 ${
              telemetry.status === 'healthy'
                ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
                : 'bg-rose-500/15 border-rose-500/40 text-rose-300 animate-pulse'
            }`}
          >
            <Activity className="w-3.5 h-3.5" />
            <span>checkout-api: {telemetry.deployedVersion}</span>
            <span className="opacity-60">|</span>
            <span>5xx: {telemetry.errorRatePct}%</span>
            <span className="opacity-60">|</span>
            <span>p99: {telemetry.p99LatencyMs}ms</span>
          </div>

          <button
            onClick={openTemplatesModal}
            className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-xs font-medium text-slate-200 flex items-center gap-1.5 transition"
          >
            <Code2 className="w-3.5 h-3.5 text-emerald-400" />
            Switch YAML Template
          </button>

          {onHome && (
            <button
              onClick={onHome}
              className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-xs font-medium text-slate-200 flex items-center gap-1.5 transition"
              title="Back to landing page"
            >
              <Home className="w-3.5 h-3.5 text-slate-400" />
              Home
            </button>
          )}
        </div>
      </header>

      {/* Chaos Fault Trigger Strip */}
      <section className="border-b border-slate-800/80 bg-slate-900/40 px-5 py-2.5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-xs text-slate-300">
          <Flame className="w-4 h-4 text-amber-400" />
          <span className="font-medium">Chaos Release Simulator:</span>
          <span className="text-slate-400 hidden sm:inline">
            Deploy a buggy <code className="text-amber-300 font-mono">v2.14.0</code> commit to watch Switch agents triage, patch & gate across rooms:
          </span>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <button
            disabled={busyAction !== null}
            onClick={() => injectChaos('jpy_zero_decimal_500')}
            className="px-2.5 py-1.5 rounded-md bg-rose-500/15 hover:bg-rose-500/25 border border-rose-500/35 text-rose-200 text-xs font-mono flex items-center gap-1.5 transition disabled:opacity-50"
          >
            <Zap className="w-3.5 h-3.5 text-rose-400" />
            1. JPY Zero-Decimal 500
          </button>
          <button
            disabled={busyAction !== null}
            onClick={() => injectChaos('promo_negative_ledger_500')}
            className="px-2.5 py-1.5 rounded-md bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/35 text-amber-200 text-xs font-mono flex items-center gap-1.5 transition disabled:opacity-50"
          >
            <Zap className="w-3.5 h-3.5 text-amber-400" />
            2. Stacked Promo Negative 500
          </button>
          <button
            disabled={busyAction !== null}
            onClick={() => injectChaos('inventory_lock_leak_503')}
            className="px-2.5 py-1.5 rounded-md bg-purple-500/15 hover:bg-purple-500/25 border border-purple-500/35 text-purple-200 text-xs font-mono flex items-center gap-1.5 transition disabled:opacity-50"
          >
            <Lock className="w-3.5 h-3.5 text-purple-400" />
            3. Inventory Lock Leak 503
          </button>
        </div>
      </section>

      {/* Active Human-in-the-Loop Release Gate Callout */}
      {activeInc && activeInc.stage === 'awaiting_human_gate' && (
        <div className="bg-amber-500/10 border-b border-amber-500/40 px-5 py-3 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0" />
            <div className="text-xs">
              <div className="font-semibold text-amber-200">
                HUMAN SIGN-OFF REQUIRED IN <span className="font-mono">#vigil-releases</span> — {activeInc.incidentId}: {activeInc.title}
              </div>
              <div className="text-amber-300/80">
                Patch <code className="font-mono">{activeInc.patchVerification?.candidateVersion}</code> verified (
                {activeInc.patchVerification?.testMatrix.length}/{activeInc.patchVerification?.testMatrix.length} green vectors). Deterministic gate blocks AI self-approval; human sign-off required.
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={async () => {
                setSelectedRoomId(snap.roomIds.releasesRoomId);
                await postChatMessage(
                  snap.roomIds.releasesRoomId,
                  `@vigil-release-gate approve ${activeInc.incidentId} promote`,
                  { username: 'vigil-patcher', displayName: 'vigil-patcher (Rogue Agent Test)' },
                );
              }}
              className="px-2.5 py-1.5 rounded-md bg-slate-900 hover:bg-slate-800 border border-rose-500/40 text-rose-300 text-xs font-mono flex items-center gap-1.5 transition"
              title="Proves that ReleaseSafetyGate deterministically rejects approvals from AI agent identities"
            >
              <ShieldAlert className="w-3.5 h-3.5" />
              Test Rogue Agent Block
            </button>

            <button
              onClick={async () => {
                setSelectedRoomId(snap.roomIds.releasesRoomId);
                await postChatMessage(
                  snap.roomIds.releasesRoomId,
                  `@vigil-release-gate approve ${activeInc.incidentId} promote`,
                );
                setRightTab('patch');
              }}
              className="px-3 py-1.5 rounded-md bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold flex items-center gap-1.5 shadow transition"
            >
              <UserCheck className="w-3.5 h-3.5" />
              Approve & Promote Hotfix (as Priya)
            </button>

            <button
              onClick={async () => {
                setSelectedRoomId(snap.roomIds.releasesRoomId);
                await postChatMessage(
                  snap.roomIds.releasesRoomId,
                  `@vigil-release-gate approve ${activeInc.incidentId} rollback`,
                );
              }}
              className="px-3 py-1.5 rounded-md bg-slate-800 hover:bg-slate-700 border border-slate-600 text-slate-200 text-xs font-medium flex items-center gap-1.5 transition"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              Rollback to v2.13.2
            </button>
          </div>
        </div>
      )}

      {/* Main 3-Column War Room Layout */}
      <main className="flex-1 grid grid-cols-1 lg:grid-cols-12 min-h-0">
        {/* LEFT COLUMN: Switch Linked Rooms Topology, Role Leases & Connected Agents */}
        <aside className="lg:col-span-3 border-r border-slate-800/90 bg-slate-900/30 p-4 flex flex-col gap-5 overflow-y-auto">
          <div>
            <div className="flex items-center justify-between mb-2.5">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
                <Network className="w-3.5 h-3.5 text-emerald-400" />
                Linked Switch Rooms
              </h2>
              <span className="text-[11px] font-mono text-slate-500">
                bridge: {snap.switchState.rooms[0]?.bridge ?? 'Mattermost'}
              </span>
            </div>

            <div className="space-y-2">
              {snap.switchState.rooms.map((room, idx) => {
                const isSelected = currentRoom?.id === room.id;
                const leasedRoles = room.roles.filter((r) => r.holder_name);
                return (
                  <React.Fragment key={room.id}>
                    <button
                      onClick={() => setSelectedRoomId(room.id)}
                      className={`w-full text-left p-3 rounded-xl border transition ${
                        isSelected
                          ? 'bg-emerald-500/10 border-emerald-500/50 shadow-sm'
                          : 'bg-slate-900/70 hover:bg-slate-800/70 border-slate-800'
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-mono text-sm font-semibold text-white">
                          #{room.name}
                        </span>
                        <span className="text-[11px] font-mono px-1.5 py-0.5 rounded bg-slate-800 text-slate-300">
                          seq:{room.seq}
                        </span>
                      </div>
                      <p className="text-xs text-slate-400 mt-1 line-clamp-2">{room.description}</p>

                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {room.roles.map((role) => (
                          <span
                            key={role.name}
                            className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${
                              role.holder_name
                                ? 'bg-amber-500/15 border-amber-500/40 text-amber-200'
                                : 'bg-slate-950/70 border-slate-800 text-slate-500'
                            }`}
                          >
                            {role.exclusive ? '🔒 ' : ''}
                            {role.name}: {role.holder_name ?? 'idle'}
                          </span>
                        ))}
                      </div>

                      {leasedRoles.length > 0 && (
                        <div className="mt-1.5 text-[11px] text-emerald-300 font-mono">
                          ● Active lease held
                        </div>
                      )}
                    </button>

                    {idx < snap.switchState.rooms.length - 1 && (
                      <div className="flex items-center gap-1.5 pl-4 text-[11px] font-mono text-slate-500">
                        <ArrowRight className="w-3 h-3 text-emerald-500/70" />
                        <span className="truncate">
                          {snap.switchState.links[idx]?.label ?? 'linked room escalation'}
                        </span>
                      </div>
                    )}
                  </React.Fragment>
                );
              })}
            </div>
          </div>

          {/* Connected WebSocket Protocol Teammates */}
          <div>
            <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-400 flex items-center gap-1.5 mb-2.5">
              <Bot className="w-3.5 h-3.5 text-indigo-400" />
              Switch WebSocket Agents
            </h2>
            <div className="space-y-2">
              {snap.switchState.agents.map((ag) => (
                <div
                  key={ag.id}
                  className="p-2.5 rounded-lg bg-slate-900/70 border border-slate-800 text-xs"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-mono font-medium text-slate-100 flex items-center gap-1.5">
                      <span
                        className={`w-2 h-2 rounded-full ${
                          ag.online ? 'bg-emerald-400' : 'bg-rose-400'
                        }`}
                      />
                      @{ag.name}
                    </span>
                    <span className="text-[10px] font-mono text-slate-400">
                      cursor:{ag.cursor} · gen:{ag.generation ?? '-'}
                    </span>
                  </div>
                  <p className="text-[11px] text-slate-400 mt-1">{ag.description}</p>
                </div>
              ))}
            </div>
          </div>
        </aside>

        {/* CENTER COLUMN: Live Switch Room Append-Only Message Log & Human Chat Bar */}
        <section className="lg:col-span-5 border-r border-slate-800/90 flex flex-col h-[calc(100vh-135px)]">
          {currentRoom && (
            <>
              <div className="px-4 py-3 border-b border-slate-800/80 bg-slate-900/50 flex items-center justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-mono font-semibold text-sm text-white">
                      #{currentRoom.name}
                    </span>
                    <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-slate-800 text-slate-300">
                      {currentRoom.documents.length} room docs
                    </span>
                  </div>
                  <p className="text-xs text-slate-400 mt-0.5">{currentRoom.description}</p>
                </div>
                <span className="text-[11px] font-mono text-emerald-400">
                  Append-only log · seq #{currentRoom.seq}
                </span>
              </div>

              {/* Messages Stream */}
              <div className="flex-1 overflow-y-auto p-4 space-y-3">
                {currentRoom.messages.map((m) => {
                  const isAgent = m.sender.startsWith('@switch-agent-');
                  return (
                    <div
                      key={m.message_id}
                      className={`p-3 rounded-xl border text-xs leading-relaxed ${
                        isAgent
                          ? 'bg-slate-900/85 border-slate-800'
                          : 'bg-indigo-950/30 border-indigo-500/35'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2 mb-1.5">
                        <div className="flex items-center gap-2">
                          <span
                            className={`px-1.5 py-0.5 rounded text-[10px] font-mono uppercase ${
                              isAgent
                                ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
                                : 'bg-indigo-500/20 text-indigo-200 border border-indigo-500/40'
                            }`}
                          >
                            {isAgent ? 'Agent' : 'Human'}
                          </span>
                          <span className="font-semibold text-slate-100">{m.sender_name}</span>
                          <span className="font-mono text-[10px] text-slate-500">{m.sender}</span>
                        </div>
                        <span className="font-mono text-[10px] text-slate-500">seq #{m.seq}</span>
                      </div>
                      <pre className="whitespace-pre-wrap font-sans text-slate-200 text-xs overflow-x-auto">
                        {m.body}
                      </pre>
                    </div>
                  );
                })}
                <div ref={messagesEndRef} />
              </div>

              {/* Quick Prompts & Team Chat Input */}
              <form
                onSubmit={handleSendChat}
                className="p-3 border-t border-slate-800 bg-slate-900/70 space-y-2"
              >
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="text-[10px] font-mono text-slate-400">Quick mention:</span>
                  <button
                    type="button"
                    onClick={() => setChatInput('@vigil-sentinel status')}
                    className="text-[11px] font-mono px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-300"
                  >
                    @vigil-sentinel status
                  </button>
                  <button
                    type="button"
                    onClick={() => setChatInput('@vigil-patcher show diff')}
                    className="text-[11px] font-mono px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-300"
                  >
                    @vigil-patcher show diff
                  </button>
                  {activeInc && (
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedRoomId(snap.roomIds.releasesRoomId);
                        setChatInput(`@vigil-release-gate approve ${activeInc.incidentId} promote`);
                      }}
                      className="text-[11px] font-mono px-2 py-0.5 rounded bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-300 border border-emerald-500/30"
                    >
                      approve {activeInc.incidentId} promote
                    </button>
                  )}
                </div>

                <div className="flex items-center gap-2">
                  <select
                    value={operatorHandle}
                    onChange={(e) => setOperatorHandle(e.target.value)}
                    className="bg-slate-950 border border-slate-700 rounded-lg px-2 py-2 text-xs font-mono text-slate-200"
                  >
                    <option value="priya">Priya (Lead)</option>
                    <option value="sam">Sam (SRE)</option>
                  </select>
                  <input
                    type="text"
                    value={chatInput}
                    onChange={(e) => setChatInput(e.target.value)}
                    placeholder={`Message #${currentRoom.name} as @switch-user-${operatorHandle}...`}
                    className="flex-1 bg-slate-950 border border-slate-700 focus:border-emerald-500 rounded-lg px-3 py-2 text-xs text-slate-100 outline-none"
                  />
                  <button
                    type="submit"
                    className="px-3 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium flex items-center gap-1.5 transition"
                  >
                    <Send className="w-3.5 h-3.5" />
                    Send
                  </button>
                </div>
              </form>
            </>
          )}
        </section>

        {/* RIGHT COLUMN: Room-Scoped Documents, Live WebSocket Wire Inspector & Patch/Canary Matrix */}
        <section className="lg:col-span-4 flex flex-col h-[calc(100vh-135px)] bg-slate-950/60">
          <div className="border-b border-slate-800 px-3 pt-2 flex items-center gap-1 bg-slate-900/50">
            <button
              onClick={() => setRightTab('docs')}
              className={`px-3 py-2 text-xs font-medium border-b-2 flex items-center gap-1.5 transition ${
                rightTab === 'docs'
                  ? 'border-emerald-400 text-emerald-300'
                  : 'border-transparent text-slate-400 hover:text-slate-200'
              }`}
            >
              <FileText className="w-3.5 h-3.5" />
              Room Docs ({allDocuments.length})
            </button>
            <button
              onClick={() => setRightTab('wire')}
              className={`px-3 py-2 text-xs font-medium border-b-2 flex items-center gap-1.5 transition ${
                rightTab === 'wire'
                  ? 'border-emerald-400 text-emerald-300'
                  : 'border-transparent text-slate-400 hover:text-slate-200'
              }`}
            >
              <Terminal className="w-3.5 h-3.5" />
              WS Protocol ({snap.wireTraces.length})
            </button>
            <button
              onClick={() => setRightTab('patch')}
              className={`px-3 py-2 text-xs font-medium border-b-2 flex items-center gap-1.5 transition ${
                rightTab === 'patch'
                  ? 'border-emerald-400 text-emerald-300'
                  : 'border-transparent text-slate-400 hover:text-slate-200'
              }`}
            >
              <GitCommit className="w-3.5 h-3.5" />
              Patch & Canary
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-4">
            {rightTab === 'docs' && (
              <div className="space-y-3">
                <div className="flex flex-wrap gap-1.5">
                  {allDocuments.map((d) => (
                    <button
                      key={`${d.roomId}:${d.name}`}
                      onClick={() => setSelectedDocName(d.name)}
                      className={`text-[11px] font-mono px-2 py-1 rounded border transition ${
                        activeDoc?.name === d.name
                          ? 'bg-emerald-500/15 border-emerald-500/50 text-emerald-200'
                          : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      {d.name}
                    </button>
                  ))}
                </div>

                {activeDoc && (
                  <div className="rounded-xl border border-slate-800 bg-slate-900/80 p-3.5 space-y-2">
                    <div className="flex items-center justify-between text-[11px] font-mono text-slate-400">
                      <span>room: #{activeDoc.roomName}</span>
                      <span>author: {activeDoc.created_by_name}</span>
                    </div>
                    <p className="text-xs text-slate-300">{activeDoc.description}</p>
                    <pre className="p-3 rounded-lg bg-slate-950 border border-slate-800 font-mono text-[11px] text-slate-200 whitespace-pre-wrap overflow-x-auto">
                      {activeDoc.content}
                    </pre>
                  </div>
                )}
              </div>
            )}

            {rightTab === 'wire' && (
              <div className="space-y-2">
                <p className="text-[11px] text-slate-400 mb-2">
                  Live Switch Agent Protocol frames (<code className="font-mono">connection_state</code>, 2s{' '}
                  <code className="font-mono">ping/pong</code> cursors, <code className="font-mono">message</code>, and{' '}
                  <code className="font-mono">X-Switch-Connection-Id</code> ops):
                </p>
                {snap.wireTraces.map((t) => (
                  <div
                    key={t.id}
                    className="p-2.5 rounded-lg bg-slate-900/80 border border-slate-800 font-mono text-[11px]"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span
                        className={`px-1.5 py-0.5 rounded text-[10px] ${
                          t.direction === 'http_op'
                            ? 'bg-amber-500/15 text-amber-300'
                            : t.direction === 'outbound'
                              ? 'bg-indigo-500/15 text-indigo-300'
                              : 'bg-emerald-500/15 text-emerald-300'
                        }`}
                      >
                        {t.frameType}
                      </span>
                      <span className="text-slate-400">{t.agentName}</span>
                    </div>
                    <div className="text-slate-300 mt-1 break-words">{t.summary}</div>
                  </div>
                ))}
              </div>
            )}

            {rightTab === 'patch' && (
              <div className="space-y-4 text-xs">
                {!latestInc ? (
                  <div className="p-6 rounded-xl border border-dashed border-slate-800 text-center text-slate-400">
                    Trigger any Chaos Release scenario above to inspect live bug reproduction, surgical diff, test matrix, and post-deploy synthetic canary probes.
                  </div>
                ) : (
                  <>
                    <div className="p-3 rounded-xl bg-slate-900/80 border border-slate-800 space-y-1">
                      <div className="flex items-center justify-between">
                        <span className="font-mono font-semibold text-white">
                          {latestInc.incidentId} · {latestInc.stage.toUpperCase()}
                        </span>
                        <span className="font-mono text-[11px] text-amber-300">
                          commit {latestInc.alert.suspectedCommit.sha}
                        </span>
                      </div>
                      <p className="text-slate-300">{latestInc.title}</p>
                    </div>

                    {latestInc.patchVerification && (
                      <>
                        <div>
                          <h3 className="font-semibold text-slate-300 mb-1.5">
                            Staged Surgical Diff ({latestInc.patchVerification.candidateVersion})
                          </h3>
                          <pre className="p-3 rounded-lg bg-slate-950 border border-slate-800 font-mono text-[11px] text-emerald-300 overflow-x-auto">
                            {latestInc.patchVerification.diffUnified}
                          </pre>
                        </div>

                        <div>
                          <h3 className="font-semibold text-slate-300 mb-1.5">
                            5-Vector Regression Matrix
                          </h3>
                          <div className="space-y-1.5">
                            {latestInc.patchVerification.testMatrix.map((vec) => (
                              <div
                                key={vec.name}
                                className="p-2 rounded-lg bg-slate-900/70 border border-slate-800 flex items-start gap-2"
                              >
                                <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                                <div>
                                  <div className="font-medium text-slate-200">{vec.name}</div>
                                  <div className="font-mono text-[11px] text-slate-400">
                                    {vec.detail}
                                  </div>
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      </>
                    )}

                    {latestInc.gateDecisions.length > 0 && (
                      <div>
                        <h3 className="font-semibold text-slate-300 mb-1.5">
                          Release Safety Gate Audit Log
                        </h3>
                        <div className="space-y-1.5">
                          {latestInc.gateDecisions.map((gd, idx) => (
                            <div
                              key={idx}
                              className={`p-2.5 rounded-lg border text-[11px] ${
                                gd.allowed
                                  ? 'bg-emerald-500/10 border-emerald-500/35 text-emerald-200'
                                  : 'bg-rose-500/10 border-rose-500/35 text-rose-200'
                              }`}
                            >
                              <div className="font-mono font-semibold">{gd.reasonCode}</div>
                              <div className="mt-0.5">{gd.explanation}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {latestInc.canaryReport && (
                      <div>
                        <h3 className="font-semibold text-emerald-300 mb-1.5 flex items-center gap-1.5">
                          <Play className="w-3.5 h-3.5" />
                          Post-Deploy Synthetic Canary ({latestInc.canaryReport.probesPassed}/
                          {latestInc.canaryReport.probesRun} 200 OK)
                        </h3>
                        <div className="p-2.5 rounded-lg bg-slate-950 border border-emerald-500/30 font-mono text-[11px] text-slate-300 space-y-1">
                          {latestInc.canaryReport.details.map((line, i) => (
                            <div key={i}>✓ {line}</div>
                          ))}
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        </section>
      </main>

      {/* Switch Group Template Modal */}
      {showTemplateModal && (
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl max-w-3xl w-full max-h-[85vh] flex flex-col shadow-2xl">
            <div className="px-5 py-3.5 border-b border-slate-800 flex items-center justify-between">
              <div>
                <h3 className="font-semibold text-sm text-white">
                  templates/vigil-war-room.template.yaml
                </h3>
                <p className="text-xs text-slate-400">
                  Import directly into Switch Console → Templates → Import template to provision all 3 linked rooms, roles, docs & agents in Mattermost, Discord, Telegram, or Slack.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(templateYaml);
                    setCopiedYaml(true);
                    setTimeout(() => setCopiedYaml(false), 2000);
                  }}
                  className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium flex items-center gap-1.5"
                >
                  <Copy className="w-3.5 h-3.5" />
                  {copiedYaml ? 'Copied!' : 'Copy YAML'}
                </button>
                <button
                  onClick={() => setShowTemplateModal(false)}
                  className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs"
                >
                  Close
                </button>
              </div>
            </div>
            <pre className="p-5 overflow-y-auto font-mono text-xs text-slate-200 whitespace-pre">
              {templateYaml}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}
