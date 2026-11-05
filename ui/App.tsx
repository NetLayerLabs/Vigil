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
  Archive,
  HeartPulse,
  Scale,
  Skull,
  Upload,
  Wrench,
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
  archived?: boolean;
  ephemeral?: boolean;
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
    author: string;
    source: 'vigil-patcher' | 'external-coder';
  } | null;
  workroom: { roomId: string; roomName: string; archived: boolean } | null;
  patchMode: 'auto' | 'external';
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
  patchMode: 'auto' | 'external';
  externalCoderHandle: string;
  releasePolicy: {
    maxChangedLines: number;
    forbiddenPaths: string[];
    requireGreenMatrix: boolean;
    allowedApprovers: string[];
    minCanaryProbes: number;
  };
  policyAudit: Array<{ at: number; senderName: string; accepted: boolean; summary: string }>;
  failovers: Array<{
    at: number;
    previousGeneration: number | null;
    newGeneration: number | null;
    resumedFromCursor: number;
    leaseReclaimed: boolean;
    previousConnectionEvicted: boolean;
  }>;
  retiredSentinels: Array<{ connectionId: string; generation: number | null; evicted: boolean; hung: boolean }>;
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
  const [externalDiff, setExternalDiff] = useState<string>('');
  const [externalAuthor, setExternalAuthor] = useState<string>('claude-code');
  const [stageResult, setStageResult] = useState<string>('');
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

  const setPatchMode = async (mode: 'auto' | 'external') => {
    setBusyAction('patch-mode');
    try {
      await fetch('/api/patch-mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
      });
    } finally {
      setBusyAction(null);
    }
  };

  const chaosCall = async (path: string) => {
    setBusyAction(path);
    try {
      await fetch(path, { method: 'POST' });
      if (snap?.roomIds.incidentsRoomId) setSelectedRoomId(snap.roomIds.incidentsRoomId);
    } finally {
      setBusyAction(null);
    }
  };

  const loadReferenceFix = async (incidentId: string) => {
    const res = await fetch(`/api/incidents/${incidentId}/reference-fix`);
    if (res.ok) {
      const data = await res.json();
      setExternalDiff(data.diffUnified ?? '');
    }
  };

  const submitExternalPatch = async (incidentId: string) => {
    if (!externalDiff.trim()) return;
    setBusyAction('stage-patch');
    setStageResult('');
    try {
      const res = await fetch(`/api/incidents/${incidentId}/stage-patch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ diffUnified: externalDiff, author: externalAuthor || 'claude-code' }),
      });
      const data = await res.json();
      setStageResult(data.next ?? data.error ?? (res.ok ? 'Accepted' : 'Rejected'));
      if (snap?.roomIds.hotfixRoomId) setSelectedRoomId(snap.roomIds.hotfixRoomId);
    } finally {
      setBusyAction(null);
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

          <span className="hidden md:inline-block w-px h-5 bg-slate-700 mx-1" />

          <div
            className="flex items-center rounded-md border border-slate-700 bg-slate-900 text-[11px] font-mono overflow-hidden"
            title="Who writes the fix: Vigil's own patcher, or a coding agent you already use (Claude Code / Codex) bound through Switch Console. Vigil verifies either way."
          >
            <span className="px-2 py-1.5 text-slate-400 flex items-center gap-1">
              <Wrench className="w-3 h-3" /> patcher:
            </span>
            <button
              disabled={busyAction !== null}
              onClick={() => setPatchMode('auto')}
              className={`px-2 py-1.5 transition ${
                snap.patchMode === 'auto' ? 'bg-emerald-600 text-white' : 'text-slate-300 hover:bg-slate-800'
              }`}
            >
              vigil-patcher
            </button>
            <button
              disabled={busyAction !== null}
              onClick={() => setPatchMode('external')}
              className={`px-2 py-1.5 transition ${
                snap.patchMode === 'external' ? 'bg-indigo-600 text-white' : 'text-slate-300 hover:bg-slate-800'
              }`}
            >
              @{snap.externalCoderHandle} (Switch Console)
            </button>
          </div>

          <button
            disabled={busyAction !== null}
            onClick={() => chaosCall('/api/chaos/crash-sentinel')}
            className="px-2.5 py-1.5 rounded-md bg-slate-900 hover:bg-slate-800 border border-rose-500/40 text-rose-300 text-xs font-mono flex items-center gap-1.5 transition disabled:opacity-50"
            title="Wedge the live incident commander: socket stays open, pings go unanswered"
          >
            <Skull className="w-3.5 h-3.5" />
            Crash Sentinel
          </button>
          <button
            disabled={busyAction !== null}
            onClick={() => chaosCall('/api/chaos/failover-sentinel')}
            className="px-2.5 py-1.5 rounded-md bg-slate-900 hover:bg-slate-800 border border-emerald-500/40 text-emerald-300 text-xs font-mono flex items-center gap-1.5 transition disabled:opacity-50"
            title="Standby sentinel reopens the same connection_id from the last cursor; old socket is evicted with taken_over and the incident-commander lease is re-asserted"
          >
            <HeartPulse className="w-3.5 h-3.5" />
            Failover Sentinel
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
                          : room.archived
                            ? 'bg-slate-950/50 hover:bg-slate-900/60 border-slate-800/60 opacity-70'
                            : 'bg-slate-900/70 hover:bg-slate-800/70 border-slate-800'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className={`font-mono text-sm font-semibold ${room.archived ? 'text-slate-500 line-through' : 'text-white'}`}>
                          #{room.name}
                        </span>
                        <span className="flex items-center gap-1">
                          {room.ephemeral && (
                            <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded border flex items-center gap-1 ${
                              room.archived
                                ? 'bg-slate-900 border-slate-700 text-slate-500'
                                : 'bg-sky-500/15 border-sky-500/40 text-sky-200'
                            }`}>
                              <Archive className="w-3 h-3" />
                              {room.archived ? 'archived' : 'ephemeral'}
                            </span>
                          )}
                          <span className="text-[11px] font-mono px-1.5 py-0.5 rounded bg-slate-800 text-slate-300">
                            seq:{room.seq}
                          </span>
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

                    {!room.ephemeral && idx < 2 && (
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

          {(snap.failovers.length > 0 || snap.retiredSentinels.length > 0) && (
            <div>
              <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-400 flex items-center gap-1.5 mb-2.5">
                <HeartPulse className="w-3.5 h-3.5 text-rose-400" />
                Commander Failover Log
              </h2>
              <div className="space-y-2 text-[11px] font-mono">
                {snap.retiredSentinels.map((r) => (
                  <div key={r.connectionId + String(r.generation)} className="p-2.5 rounded-lg bg-slate-900/70 border border-rose-500/30 text-rose-200">
                    gen {r.generation ?? '-'} · conn {r.connectionId.slice(0, 8)}… · {r.hung ? 'hung' : 'live'} ·{' '}
                    {r.evicted ? 'evicted: taken_over' : 'awaiting eviction'}
                  </div>
                ))}
                {snap.failovers.map((f) => (
                  <div key={f.at} className="p-2.5 rounded-lg bg-slate-900/70 border border-emerald-500/30 text-emerald-200">
                    standby gen {f.newGeneration ?? '-'} resumed from cursor {f.resumedFromCursor} · lease{' '}
                    {f.leaseReclaimed ? 're-asserted' : 'not needed'}
                  </div>
                ))}
              </div>
            </div>
          )}
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
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedRoomId(snap.roomIds.releasesRoomId);
                      setChatInput('@vigil-release-gate policy');
                    }}
                    className="text-[11px] font-mono px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-300"
                  >
                    @vigil-release-gate policy
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedRoomId(snap.roomIds.releasesRoomId);
                      setChatInput('@vigil-release-gate set max diff 1');
                    }}
                    className="text-[11px] font-mono px-2 py-0.5 rounded bg-amber-500/15 hover:bg-amber-500/25 text-amber-200 border border-amber-500/30"
                    title="Tighten the room policy from chat so the staged patch gets rejected on the next approval"
                  >
                    set max diff 1
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
                {/* Governance: policy read live from the release-safety-policy room document */}
                <div className="p-3 rounded-xl bg-slate-900/80 border border-slate-800 space-y-2">
                  <div className="flex items-center justify-between">
                    <h3 className="font-semibold text-slate-200 flex items-center gap-1.5">
                      <Scale className="w-3.5 h-3.5 text-amber-400" />
                      Release Policy · from <code className="font-mono text-amber-300">release-safety-policy</code> room doc
                    </h3>
                    <span className="text-[10px] font-mono text-slate-500">humans edit via chat</span>
                  </div>
                  <div className="grid grid-cols-2 gap-1.5 font-mono text-[11px]">
                    <div className="p-1.5 rounded bg-slate-950 border border-slate-800 text-slate-300">
                      max_changed_lines: <span className="text-white">{snap.releasePolicy.maxChangedLines}</span>
                    </div>
                    <div className="p-1.5 rounded bg-slate-950 border border-slate-800 text-slate-300">
                      require_green_matrix: <span className="text-white">{String(snap.releasePolicy.requireGreenMatrix)}</span>
                    </div>
                    <div className="p-1.5 rounded bg-slate-950 border border-slate-800 text-slate-300 col-span-2 truncate">
                      allowed_approvers: <span className="text-white">{snap.releasePolicy.allowedApprovers.join(', ')}</span>
                    </div>
                    <div className="p-1.5 rounded bg-slate-950 border border-slate-800 text-slate-300 col-span-2 truncate">
                      forbidden_paths: <span className="text-white">{snap.releasePolicy.forbiddenPaths.join(', ') || 'none'}</span>
                    </div>
                  </div>
                  {snap.policyAudit.length > 0 && (
                    <div className="space-y-1">
                      {snap.policyAudit.slice(-4).reverse().map((a) => (
                        <div
                          key={a.at}
                          className={`text-[11px] font-mono px-2 py-1 rounded border ${
                            a.accepted
                              ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-200'
                              : 'bg-rose-500/10 border-rose-500/30 text-rose-200'
                          }`}
                        >
                          {a.senderName}: {a.summary}
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* External coder intake: shown when the incident is routed to a Switch Console coding agent */}
                {latestInc && latestInc.patchMode === 'external' && !latestInc.canaryReport && !latestInc.patchVerification?.allPassed && (
                  <div className="p-3 rounded-xl bg-indigo-950/30 border border-indigo-500/35 space-y-2">
                    <h3 className="font-semibold text-indigo-200 flex items-center gap-1.5">
                      <Upload className="w-3.5 h-3.5" />
                      External patch intake · {latestInc.incidentId} · author @{snap.externalCoderHandle}
                    </h3>
                    <p className="text-[11px] text-indigo-200/80">
                      Claude Code (or any coding agent in <code className="font-mono">#vigil-hotfix</code>) hands its unified diff to{' '}
                      <code className="font-mono">@vigil-patcher</code> in a <code className="font-mono">```diff</code> fence or via{' '}
                      <code className="font-mono">POST /api/incidents/{latestInc.incidentId}/stage-patch</code>. Vigil verifies it; a diff without the fix is rejected.
                    </p>
                    <div className="flex items-center gap-2">
                      <input
                        value={externalAuthor}
                        onChange={(e) => setExternalAuthor(e.target.value)}
                        className="w-36 bg-slate-950 border border-slate-700 rounded px-2 py-1 text-[11px] font-mono text-slate-200"
                        placeholder="author handle"
                      />
                      <button
                        type="button"
                        onClick={() => loadReferenceFix(latestInc.incidentId)}
                        className="text-[11px] font-mono px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300"
                      >
                        Load reference fix
                      </button>
                      <button
                        type="button"
                        onClick={() => setExternalDiff('--- a/src/services/cartPricing.ts\n+++ b/src/services/cartPricing.ts\n@@ -1,1 +1,1 @@\n-// TODO\n+// cosmetic comment only, does not fix the fault')}
                        className="text-[11px] font-mono px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-rose-300"
                        title="A diff that doesn't carry the fix: the verifier must reject it"
                      >
                        Load bad diff
                      </button>
                    </div>
                    <textarea
                      value={externalDiff}
                      onChange={(e) => setExternalDiff(e.target.value)}
                      rows={7}
                      spellCheck={false}
                      placeholder={'--- a/src/services/cartPricing.ts\n+++ b/src/services/cartPricing.ts\n@@ ... @@\n+  JPY: { minorScale: 1 },'}
                      className="w-full bg-slate-950 border border-slate-700 focus:border-indigo-400 rounded-lg p-2 font-mono text-[11px] text-emerald-200 outline-none"
                    />
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[11px] font-mono text-slate-400 truncate">{stageResult}</span>
                      <button
                        type="button"
                        disabled={busyAction !== null || !externalDiff.trim()}
                        onClick={() => submitExternalPatch(latestInc.incidentId)}
                        className="px-3 py-1.5 rounded-md bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold flex items-center gap-1.5 transition disabled:opacity-50"
                      >
                        <Upload className="w-3.5 h-3.5" />
                        Submit to @vigil-patcher
                      </button>
                    </div>
                  </div>
                )}

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
                      <div className="flex flex-wrap gap-1.5 pt-1 text-[10px] font-mono">
                        <span className={`px-1.5 py-0.5 rounded border ${latestInc.patchMode === 'external' ? 'bg-indigo-500/15 border-indigo-500/40 text-indigo-200' : 'bg-emerald-500/15 border-emerald-500/40 text-emerald-200'}`}>
                          patcher: {latestInc.patchMode === 'external' ? `@${snap.externalCoderHandle} (verified by vigil-patcher)` : 'vigil-patcher'}
                        </span>
                        {latestInc.patchVerification && (
                          <span className="px-1.5 py-0.5 rounded border bg-slate-950 border-slate-700 text-slate-300">
                            author: {latestInc.patchVerification.author}
                          </span>
                        )}
                        {latestInc.workroom && (
                          <button
                            type="button"
                            onClick={() => setSelectedRoomId(latestInc.workroom!.roomId)}
                            className={`px-1.5 py-0.5 rounded border flex items-center gap-1 ${latestInc.workroom.archived ? 'bg-slate-900 border-slate-700 text-slate-400' : 'bg-sky-500/15 border-sky-500/40 text-sky-200 hover:bg-sky-500/25'}`}
                          >
                            <Archive className="w-3 h-3" />
                            #{latestInc.workroom.roomName} {latestInc.workroom.archived ? '(archived)' : '(open)'}
                          </button>
                        )}
                      </div>
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
                            Regression Matrix ({latestInc.patchVerification.testMatrix.filter((t) => t.passed).length}/
                            {latestInc.patchVerification.testMatrix.length} green)
                          </h3>
                          <div className="space-y-1.5">
                            {latestInc.patchVerification.testMatrix.map((vec) => (
                              <div
                                key={vec.name}
                                className="p-2 rounded-lg bg-slate-900/70 border border-slate-800 flex items-start gap-2"
                              >
                                {vec.passed ? (
                                  <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                                ) : (
                                  <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
                                )}
                                <div>
                                  <div className={`font-medium ${vec.passed ? 'text-slate-200' : 'text-rose-200'}`}>{vec.name}</div>
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
