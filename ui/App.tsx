import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Archive,
  ArrowDownRight,
  ArrowLeft,
  Code2,
  Copy,
  GitCommit,
  HeartPulse,
  Lock,
  RotateCcw,
  Scale,
  Send,
  ShieldAlert,
  Skull,
  Upload,
  UserCheck,
  X,
} from 'lucide-react';
import { VigilLogo } from './VigilMark';
import './landing.css';
import './warroom.css';

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
  /** Live server: `user`, `agent` or `platform`. */
  sender_kind?: string | null;
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
    candidateSha: string | null;
    testRunOutput: string;
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
  /** Live Switch server: the messaging app's team URL, where humans approve (`/channels/<room>`). */
  chatUrl?: string | null;
  /** Public deployment: operator controls need the operator key. */
  operatorKeyRequired?: boolean;
  switchServerUrl: string;
  checkoutBaseUrl: string;
  checkoutRepo: { workDir: string; log: Array<{ sha: string; author: string; message: string; at: number }> };
  checkoutTelemetry: {
    deployedVersion: string;
    lastKnownGoodVersion: string;
    stagedCandidateVersion: string | null;
    stagedCandidateSha: string | null;
    pid: number;
    windowRequests: number;
    totalRequests: number;
    totalErrors: number;
    errorRatePct: number;
    p99LatencyMs: number;
    activeInventoryLocks: number;
    maxInventoryLocks: number;
    status: 'healthy' | 'degraded';
    /** False when the target has no metrics endpoint: error rate, p99 and request counts are not measured. */
    metricsMeasured?: boolean;
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
  // Operator key for a public deployment, kept in this browser only.
  const [operatorKey, setOperatorKey] = useState<string>(() => {
    try {
      return localStorage.getItem('vigil-operator-key') ?? '';
    } catch {
      return '';
    }
  });
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 7000);
    return () => clearTimeout(t);
  }, [notice]);
  const opHeaders = (extra: Record<string, string> = {}): Record<string, string> =>
    operatorKey ? { ...extra, Authorization: `Bearer ${operatorKey}` } : extra;
  /** Explain a refused request (locked control, open incident, cooldown) instead of failing silently. */
  const reportRefusal = async (res: Response): Promise<boolean> => {
    if (res.ok) return false;
    const data = (await res.json().catch(() => ({}))) as { error?: string; operatorRequired?: boolean };
    setNotice(
      data.operatorRequired
        ? 'That control is for the operator. Visitors can ship a chaos release and test the rogue-agent block.'
        : (data.error ?? `Request failed (${res.status}).`),
    );
    return true;
  };
  const unlockOperator = async () => {
    const key = window.prompt('Operator key')?.trim();
    if (!key) return;
    const res = await fetch('/api/operator/check', { headers: { Authorization: `Bearer ${key}` } });
    if (!res.ok) {
      setNotice('That operator key was not accepted.');
      return;
    }
    try {
      localStorage.setItem('vigil-operator-key', key);
    } catch {
      // private mode: keep it for this tab only
    }
    setOperatorKey(key);
    setNotice('Operator controls unlocked in this browser.');
  };
  const [showTemplateModal, setShowTemplateModal] = useState<boolean>(false);
  const [templateYaml, setTemplateYaml] = useState<string>('');
  const [copiedYaml, setCopiedYaml] = useState<boolean>(false);
  const [externalDiff, setExternalDiff] = useState<string>('');
  const [externalAuthor, setExternalAuthor] = useState<string>('claude-code');
  const [stageResult, setStageResult] = useState<string>('');
  // Phones (<= 900px): the left rail becomes a drawer, and one view shows at a time.
  const [drawerOpen, setDrawerOpen] = useState<boolean>(false);
  const [mobileView, setMobileView] = useState<'room' | 'inspect'>('room');
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

  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setDrawerOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawerOpen]);

  const openRoom = (roomId: string) => {
    setSelectedRoomId(roomId);
    setMobileView('room');
    setDrawerOpen(false);
  };

  const openInspector = (tab: 'docs' | 'wire' | 'patch') => {
    setRightTab(tab);
    setMobileView('inspect');
    setDrawerOpen(false);
  };

  const injectChaos = async (scenarioId: string) => {
    setDrawerOpen(false);
    setMobileView('room');
    setBusyAction(scenarioId);
    try {
      const res = await fetch('/api/chaos/inject', {
        method: 'POST',
        headers: opHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ scenarioId }),
      });
      if (await reportRefusal(res)) return;
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
      const res = await fetch('/api/patch-mode', {
        method: 'POST',
        headers: opHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ mode }),
      });
      await reportRefusal(res);
    } finally {
      setBusyAction(null);
    }
  };

  const chaosCall = async (path: string) => {
    setDrawerOpen(false);
    setMobileView('room');
    setBusyAction(path);
    try {
      const res = await fetch(path, { method: 'POST', headers: opHeaders() });
      if (await reportRefusal(res)) return;
      if (snap?.roomIds.incidentsRoomId) setSelectedRoomId(snap.roomIds.incidentsRoomId);
    } finally {
      setBusyAction(null);
    }
  };

  const loadReferenceFix = async (incidentId: string) => {
    const res = await fetch(`/api/incidents/${incidentId}/reference-fix`, { headers: opHeaders() });
    if (await reportRefusal(res)) return;
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
        headers: opHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ diffUnified: externalDiff, author: externalAuthor || 'claude-code' }),
      });
      if (res.status === 401) {
        await reportRefusal(res);
        return;
      }
      const data = await res.json();
      setStageResult(data.next ?? data.error ?? (res.ok ? 'Accepted' : 'Rejected'));
      if (snap?.roomIds.hotfixRoomId) setSelectedRoomId(snap.roomIds.hotfixRoomId);
    } finally {
      setBusyAction(null);
    }
  };

  if (!snap) {
    return (
      <div className="wr wr-loading">
        <span className="vl-logo">
          <VigilLogo />
        </span>
        <span className="wr-label">
          <span className="wr-sq is-pulse" />
          Connecting to the Switch agent mesh
        </span>
      </div>
    );
  }

  const telemetry = snap.checkoutTelemetry;
  const activeInc = snap.activeIncident;
  const latestInc = activeInc ?? snap.incidents[0] ?? null;
  const degraded = telemetry.status !== 'healthy';
  const busy = busyAction !== null;
  const gateInc = activeInc && activeInc.stage === 'awaiting_human_gate' ? activeInc : null;
  // On a live Switch server, humans speak (and approve) in the messaging app, not on this page.
  const isLive = snap.mode !== 'embedded_switch_protocol_server';
  // The chat app the live rooms are bridged to, as the server reports it
  const chatApp = isLive ? snap.switchState.rooms.find((r) => r.bridge && r.bridge !== 'no chat bridge')?.bridge ?? 'your chat app' : null;
  const measured = telemetry.metricsMeasured !== false;
  const chatChannelUrl = (roomName: string): string | null =>
    snap.chatUrl ? `${snap.chatUrl.replace(/\/+$/, '')}/channels/${roomName.toLowerCase()}` : null;
  const gateMatrix = gateInc?.patchVerification?.testMatrix ?? [];
  const pv = latestInc?.patchVerification ?? null;
  const policy = snap.releasePolicy;

  return (
    <div className="wr">
      {/* ───────────── Top bar: brand, live telemetry, actions ───────────── */}
      <header className="wr-top">
        <div className="wr-brand">
          <a
            href="/"
            className="vl-logo wr-home"
            aria-label="Vigil, back to the landing page"
            onClick={(e) => {
              if (!onHome || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
              e.preventDefault();
              onHome();
            }}
          >
            <VigilLogo />
          </a>
          <span className="wr-sep" />
          <span className="wr-label">
            <b>War room</b>
          </span>
          <span className="wr-tag">
            {snap.mode === 'embedded_switch_protocol_server' ? 'Embedded Switch server' : 'Live Switch server'}
          </span>
        </div>

        <div
          className={`wr-telemetry ${degraded ? 'is-degraded' : ''}`}
          title="Measured from the live checkout-api process over a rolling 60s window"
        >
          <span className="wr-tm wr-tm--status">
            <span className={`wr-sq ${degraded ? 'wr-sq--alert is-pulse' : ''}`} />
            {degraded ? 'Degraded' : 'Healthy'}
          </span>
          <span className="wr-tm" title="Deployed version reported by the live service process">
            <small>checkout-api</small>
            <b>{telemetry.deployedVersion}</b>
          </span>
          <span className="wr-tm wr-tm--err">
            <small>5xx</small>
            <b>{measured ? `${telemetry.errorRatePct}%` : '—'}</b>
          </span>
          <span className="wr-tm">
            <small>p99</small>
            <b>{measured ? `${telemetry.p99LatencyMs}ms` : '—'}</b>
          </span>
          <span className="wr-tm wr-tm--hide-md" title="Requests in the measured window (synthetic traffic + probes)">
            <small>req / 60s</small>
            <b>{measured ? telemetry.windowRequests : '—'}</b>
          </span>
          <span className="wr-tm wr-tm--hide-md" title="Service process id (changes on every deploy or rollback)">
            <small>pid</small>
            <b>{telemetry.pid}</b>
          </span>
        </div>

        <div className="wr-top-actions">
          {snap.operatorKeyRequired && (
            <button
              type="button"
              className={`wr-btn wr-desk ${operatorKey ? 'wr-btn--brand' : ''}`}
              onClick={unlockOperator}
              title={operatorKey ? 'Operator controls unlocked in this browser' : 'Unlock the operator controls'}
            >
              <Lock className="wr-ic" />
              <span>{operatorKey ? 'Operator' : 'Operator key'}</span>
            </button>
          )}
          <button type="button" className="wr-btn wr-desk" onClick={openTemplatesModal}>
            <Code2 className="wr-ic" />
            <span>Switch template</span>
          </button>
          <button
            type="button"
            className={`wr-burger ${drawerOpen ? 'is-open' : ''}`}
            aria-label={drawerOpen ? 'Close rooms and controls' : 'Open rooms and controls'}
            aria-expanded={drawerOpen}
            aria-controls="wr-drawer"
            onClick={() => setDrawerOpen((v) => !v)}
          >
            <span />
            <span />
            <span />
          </button>
          {onHome && (
            <button type="button" className="wr-btn wr-btn--dark wr-desk" onClick={onHome} title="Back to the landing page">
              <ArrowLeft className="wr-ic" />
              <span>Home</span>
            </button>
          )}
        </div>
      </header>

      {/* ───────────── Control bar: chaos releases, patch author, failover ───────────── */}
      <section className="wr-bar" aria-label="Controls">
        <div className="wr-group wr-group--faults">
          <span className="wr-label">Chaos release</span>
          {FAULTS.map((f) => (
            <button
              key={f.id}
              type="button"
              className="wr-btn"
              disabled={busy}
              onClick={() => injectChaos(f.id)}
              title={`Commit a real regression to the live checkout-api working copy and restart it on v2.14.0`}
            >
              <span className={`wr-sq wr-sq--${f.tone}`} />
              <span className="wr-num">{f.n}</span>
              <span>{f.label}</span>
            </button>
          ))}
        </div>

        <div className="wr-group wr-desk">
          <span className="wr-label">Patch author</span>
          <div
            className="wr-seg"
            title="Who writes the fix: Vigil's own patcher, or a coding agent you already use (Claude Code, Codex) bound through Switch Console. Vigil verifies either way."
          >
            <button
              type="button"
              disabled={busy}
              className={snap.patchMode === 'auto' ? 'is-on' : ''}
              onClick={() => setPatchMode('auto')}
            >
              vigil-patcher
            </button>
            <button
              type="button"
              disabled={busy}
              className={snap.patchMode === 'external' ? 'is-on is-ext' : ''}
              onClick={() => setPatchMode('external')}
            >
              @{snap.externalCoderHandle}
            </button>
          </div>
          <span className="wr-sep" />
          <button
            type="button"
            className="wr-btn wr-btn--alert"
            disabled={busy}
            onClick={() => chaosCall('/api/chaos/crash-sentinel')}
            title="Wedge the live incident commander: the socket stays open, pings go unanswered"
          >
            <Skull className="wr-ic" />
            <span>Crash Sentinel</span>
          </button>
          <button
            type="button"
            className="wr-btn"
            disabled={busy}
            onClick={() => chaosCall('/api/chaos/failover-sentinel')}
            title="A standby reopens the same connection_id from the last cursor; the old socket is evicted with taken_over and the incident-commander lease is re-asserted"
          >
            <HeartPulse className="wr-ic" />
            <span>Failover Sentinel</span>
          </button>
        </div>
      </section>

      {/* ───────────── Phone view switcher (hidden on desktop) ───────────── */}
      <nav className="wr-views" aria-label="View">
        <button type="button" className={mobileView === 'room' ? 'is-on' : ''} onClick={() => setMobileView('room')}>
          Room
        </button>
        <button type="button" className={mobileView === 'inspect' && rightTab === 'docs' ? 'is-on' : ''} onClick={() => openInspector('docs')}>
          Docs
        </button>
        <button type="button" className={mobileView === 'inspect' && rightTab === 'wire' ? 'is-on' : ''} onClick={() => openInspector('wire')}>
          Protocol
        </button>
        <button type="button" className={mobileView === 'inspect' && rightTab === 'patch' ? 'is-on' : ''} onClick={() => openInspector('patch')}>
          Patch
          {latestInc && <span className={`wr-sq ${latestInc.canaryReport ? '' : gateInc ? 'wr-sq--warn is-pulse' : 'wr-sq--idle'}`} />}
        </button>
      </nav>

      {/* ───────────── Human release gate ───────────── */}
      {gateInc && (
        <section className="wr-gate" aria-live="polite">
          <div>
            <span className="wr-label">
              <span className="wr-sq wr-sq--warn is-pulse" />
              Human sign-off required in #vigil-releases
            </span>
            <p>
              <b>{gateInc.incidentId}</b> {gateInc.title}. Candidate{' '}
              <code>{gateInc.patchVerification?.candidateVersion}</code> passed{' '}
              {gateMatrix.filter((t) => t.passed).length} of {gateMatrix.length} checks (the service tests and a
              staging replay). The gate refuses approvals from agents.
            </p>
          </div>
          <div className="wr-gate-actions">
            <button
              type="button"
              className="wr-btn wr-btn--lg wr-btn--ondark wr-btn--alert"
              onClick={async () => {
                setSelectedRoomId(snap.roomIds.releasesRoomId);
                await postChatMessage(snap.roomIds.releasesRoomId, `@vigil-release-gate approve ${gateInc.incidentId} promote`, {
                  username: 'vigil-patcher',
                  displayName: 'vigil-patcher (Rogue Agent Test)',
                });
              }}
              title="Proves that the release gate deterministically rejects approvals from AI agent identities"
            >
              <ShieldAlert className="wr-ic" />
              <span>Test Rogue Agent Block</span>
            </button>
            {isLive ? (
              <a
                className="wr-btn wr-btn--lg wr-btn--brand"
                href={chatChannelUrl('vigil-releases') ?? undefined}
                target="_blank"
                rel="noreferrer"
                title={`Reply "@vigil-release-gate approve ${gateInc.incidentId} promote" (or rollback) in #vigil-releases`}
              >
                <UserCheck className="wr-ic" />
                <span>Approve in {chatApp}</span>
              </a>
            ) : (
              <>
              <button
                type="button"
                className="wr-btn wr-btn--lg wr-btn--ondark"
                onClick={async () => {
                  setSelectedRoomId(snap.roomIds.releasesRoomId);
                  await postChatMessage(snap.roomIds.releasesRoomId, `@vigil-release-gate approve ${gateInc.incidentId} rollback`);
                }}
              >
                <RotateCcw className="wr-ic" />
                <span>Rollback to {telemetry.lastKnownGoodVersion}</span>
              </button>
              <button
                type="button"
                className="wr-btn wr-btn--lg wr-btn--brand"
                onClick={async () => {
                  setSelectedRoomId(snap.roomIds.releasesRoomId);
                  setMobileView('room');
                  await postChatMessage(snap.roomIds.releasesRoomId, `@vigil-release-gate approve ${gateInc.incidentId} promote`);
                  setRightTab('patch');
                }}
              >
                <UserCheck className="wr-ic" />
                <span>Approve &amp; Promote as Priya</span>
              </button>
              </>
            )}
          </div>
        </section>
      )}

      <button
        type="button"
        className={`wr-backdrop ${drawerOpen ? 'is-open' : ''}`}
        aria-label="Close rooms and controls"
        tabIndex={drawerOpen ? 0 : -1}
        onClick={() => setDrawerOpen(false)}
      />

      <main className="wr-main" data-view={mobileView}>
        {/* ───────────── Left rail: rooms, agents, failover, git (a drawer on phones) ───────────── */}
        <aside id="wr-drawer" className={`wr-col wr-left ${drawerOpen ? 'is-open' : ''}`}>
          <div className="wr-drawer-head">
            <span className="vl-logo wr-home">
              <VigilLogo />
            </span>
            <button type="button" className="wr-drawer-close" aria-label="Close" onClick={() => setDrawerOpen(false)}>
              <X />
            </button>
          </div>

          {/* Controls that live in the top bars on desktop */}
          <div className="wr-sec wr-mob">
            <div className="wr-sec-h">
              <span className="wr-label">
                <span className="wr-sq wr-sq--violet" />
                Patch author
              </span>
            </div>
            <div className="wr-seg wr-seg--full">
              <button
                type="button"
                disabled={busy}
                className={snap.patchMode === 'auto' ? 'is-on' : ''}
                onClick={() => setPatchMode('auto')}
              >
                vigil-patcher
              </button>
              <button
                type="button"
                disabled={busy}
                className={snap.patchMode === 'external' ? 'is-on is-ext' : ''}
                onClick={() => setPatchMode('external')}
              >
                @{snap.externalCoderHandle}
              </button>
            </div>
            <div className="wr-sec-h" style={{ marginTop: 18 }}>
              <span className="wr-label">
                <span className="wr-sq wr-sq--alert" />
                Incident commander
              </span>
            </div>
            <div className="wr-drawer-grid">
              <button type="button" className="wr-btn wr-btn--alert" disabled={busy} onClick={() => chaosCall('/api/chaos/crash-sentinel')}>
                <Skull className="wr-ic" />
                <span>Crash Sentinel</span>
              </button>
              <button type="button" className="wr-btn" disabled={busy} onClick={() => chaosCall('/api/chaos/failover-sentinel')}>
                <HeartPulse className="wr-ic" />
                <span>Failover Sentinel</span>
              </button>
              <button
                type="button"
                className="wr-btn"
                onClick={() => {
                  setDrawerOpen(false);
                  openTemplatesModal();
                }}
              >
                <Code2 className="wr-ic" />
                <span>Switch template</span>
              </button>
              {snap.operatorKeyRequired && (
                <button
                  type="button"
                  className="wr-btn"
                  onClick={() => {
                    setDrawerOpen(false);
                    unlockOperator();
                  }}
                >
                  <Lock className="wr-ic" />
                  <span>{operatorKey ? 'Operator unlocked' : 'Operator key'}</span>
                </button>
              )}
              {onHome && (
                <button type="button" className="wr-btn wr-btn--dark" onClick={onHome}>
                  <ArrowLeft className="wr-ic" />
                  <span>Home</span>
                </button>
              )}
            </div>
          </div>

          <div className="wr-sec">
            <div className="wr-sec-h">
              <span className="wr-label">
                <span className="wr-sq" />
                Linked Switch rooms
              </span>
              <span className="wr-tag">{isLive ? chatApp : 'Embedded, no chat app'}</span>
            </div>
            <div className="wr-rooms">
              {snap.switchState.rooms.map((room, idx) => (
                <React.Fragment key={room.id}>
                  <button
                    type="button"
                    onClick={() => openRoom(room.id)}
                    className={`wr-room ${currentRoom?.id === room.id ? 'is-sel' : ''} ${room.archived ? 'is-archived' : ''}`}
                  >
                    <div className="wr-room-top">
                      <span className="wr-room-name">#{room.name}</span>
                      <span style={{ display: 'inline-flex', gap: 5 }}>
                        {room.ephemeral && (
                          <span className={`wr-tag ${room.archived ? '' : 'wr-tag--violet'}`}>
                            <Archive className="wr-ic" />
                            {room.archived ? 'archived' : 'workroom'}
                          </span>
                        )}
                        {room.seq > 0 && <span className="wr-tag">seq {room.seq}</span>}
                      </span>
                    </div>
                    <p className="wr-room-desc">{room.description}</p>
                    {room.roles.length > 0 && (
                      <div className="wr-roles">
                        {room.roles.map((role) => (
                          <span key={role.name} className={`wr-role ${role.holder_name ? 'is-held' : ''}`}>
                            {role.exclusive && <Lock className="wr-ic" />}
                            {role.name}: {role.holder_name ?? 'idle'}
                          </span>
                        ))}
                      </div>
                    )}
                  </button>
                  {(() => {
                    // The link that leaves this room for the next room in the rail, matched by id
                    const next = snap.switchState.rooms[idx + 1];
                    const link =
                      next &&
                      snap.switchState.links.find(
                        (l) => (l.from_room_id === room.id || !l.from_room_id) && l.to_room_id === next.id,
                      );
                    return !room.ephemeral && link ? (
                      <div className="wr-link">
                        <ArrowDownRight className="wr-ic" />
                        <span>{link.label}</span>
                      </div>
                    ) : null;
                  })()}
                </React.Fragment>
              ))}
            </div>
          </div>

          <div className="wr-sec">
            <div className="wr-sec-h">
              <span className="wr-label">
                <span className="wr-sq wr-sq--ink" />
                Switch WebSocket agents
              </span>
              <span className="wr-label">
                {snap.switchState.agents.filter((a) => a.online).length}/{snap.switchState.agents.length} online
              </span>
            </div>
            <div className="wr-rows">
              {snap.switchState.agents.map((ag) => (
                <div key={ag.id} className="wr-row">
                  <div className="wr-row-top">
                    <span className="wr-row-name">
                      <span className={`wr-sq ${ag.online ? '' : 'wr-sq--alert'}`} />@{ag.name}
                    </span>
                    <span className="wr-row-meta">{ag.online ? 'online' : 'offline'}</span>
                  </div>
                  <p className="wr-row-desc">{ag.description}</p>
                </div>
              ))}
            </div>
          </div>

          {(snap.failovers.length > 0 || snap.retiredSentinels.length > 0) && (
            <div className="wr-sec">
              <div className="wr-sec-h">
                <span className="wr-label">
                  <span className="wr-sq wr-sq--alert" />
                  Commander failover log
                </span>
              </div>
              <div className="wr-rows">
                {snap.retiredSentinels.map((r) => (
                  <div key={r.connectionId + String(r.generation)} className="wr-row wr-row--log">
                    <span className="wr-sq wr-sq--alert" />
                    <span>
                      gen {r.generation ?? '-'} · conn {r.connectionId.slice(0, 8)} · {r.hung ? 'hung' : 'live'} ·{' '}
                      {r.evicted ? 'evicted: taken_over' : 'awaiting eviction'}
                    </span>
                  </div>
                ))}
                {snap.failovers.map((f) => (
                  <div key={f.at} className="wr-row wr-row--log">
                    <span className="wr-sq" />
                    <span>
                      standby gen {f.newGeneration ?? '-'} resumed from cursor {f.resumedFromCursor} · lease{' '}
                      {f.leaseReclaimed ? 're-asserted' : 'not needed'}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="wr-sec">
            <div className="wr-sec-h">
              <span className="wr-label">
                <GitCommit className="wr-ic" />
                checkout-api git log
              </span>
              <span className="wr-label">live copy</span>
            </div>
            <div className="wr-rows">
              {snap.checkoutRepo.log.map((c, idx) => (
                <div key={c.sha} className={`wr-git ${idx === 0 ? 'is-head' : ''}`} title={c.author}>
                  <div className="wr-git-top">
                    <span className="wr-git-sha">{c.sha}</span>
                    {idx === 0 && <span className="wr-tag wr-tag--ink">HEAD</span>}
                    <span className="wr-git-author">{c.author.replace(/\s*<.*>$/, '')}</span>
                  </div>
                  <div className="wr-git-msg">{c.message}</div>
                </div>
              ))}
            </div>
            <p className="wr-path">{snap.checkoutRepo.workDir}</p>
          </div>
        </aside>

        {/* ───────────── Centre: the room's append-only log + chat ───────────── */}
        <section className="wr-col wr-center">
          {currentRoom && (
            <>
              <div className="wr-roomhead">
                <div>
                  <span className="wr-label">
                    Switch room · {currentRoom.documents.length} docs
                    {currentRoom.archived ? ' · archived' : ''}
                  </span>
                  <h1 className="wr-roomtitle">#{currentRoom.name}</h1>
                  <p>{currentRoom.description}</p>
                </div>
                <span className="wr-label">
                  Append-only{currentRoom.seq > 0 && <> · seq <b>{currentRoom.seq}</b></>}
                </span>
              </div>

              <div className="wr-feed">
                {currentRoom.messages.length === 0 && (
                  <div className="wr-empty" style={{ marginTop: 20 }}>
                    No messages in #{currentRoom.name} yet. Ship a chaos release above to start an incident.
                  </div>
                )}
                {currentRoom.messages.map((m) => {
                  // A live server says who sent it: `user` (a person), `agent`, or `platform` (Switch itself,
                  // e.g. a template kickoff posted on an agent's behalf). Without it, judge by the id.
                  const kind = m.sender_kind ?? (m.sender.startsWith('@switch-agent-') ? 'agent' : 'user');
                  const isAgent = kind === 'agent';
                  const isHuman = kind === 'user';
                  // Agents and Switch write plain text here; a person's message is shown exactly as sent.
                  const body = isHuman ? m.body : withoutPictographs(m.body);
                  // Switch's own one-line notices (a role taken or released, a document written).
                  if (!isHuman && ROOM_NOTICE.test(body)) {
                    return (
                      <div key={m.message_id} className="wr-notice">
                        <b>{m.sender_name}</b> {inlineMarkdown(body)}
                      </div>
                    );
                  }
                  return (
                    <article key={m.message_id} className={`wr-msg ${isHuman ? 'wr-msg--human' : ''}`}>
                      <div className="wr-msg-head">
                        <span className="wr-msg-name">{m.sender_name}</span>
                        <span className={`wr-tag ${isHuman ? 'wr-tag--brand' : ''}`}>
                          {isAgent ? 'agent' : isHuman ? 'person' : 'Switch'}
                        </span>
                        <span className="wr-msg-handle">{m.sender}</span>
                        {m.seq > 0 && <span className="wr-msg-seq">#{m.seq}</span>}
                      </div>
                      <MessageBody text={body} />
                    </article>
                  );
                })}
                <div ref={messagesEndRef} />
              </div>

              {isLive ? (
                <div className="wr-compose wr-compose--live">
                  <p>
                    This room is mirrored to {chatApp}. People post and approve there, so the server knows who said
                    it.{' '}
                    {activeInc?.stage === 'awaiting_human_gate' ? (
                      <>
                        Reply <code>@vigil-release-gate approve {activeInc.incidentId} promote</code> in #vigil-releases.
                      </>
                    ) : (
                      'Nothing is waiting for approval right now.'
                    )}
                  </p>
                  {chatChannelUrl(currentRoom.name) && (
                    <a className="wr-btn wr-btn--dark" href={chatChannelUrl(currentRoom.name) ?? undefined} target="_blank" rel="noreferrer">
                      <Send className="wr-ic" />
                      <span>
                        Open #{currentRoom.name} in {chatApp}
                      </span>
                    </a>
                  )}
                </div>
              ) : (
              <form onSubmit={handleSendChat} className="wr-compose">
                <div className="wr-quick">
                  <span className="wr-label">Try</span>
                  <button type="button" className="wr-chipbtn" onClick={() => setChatInput('@vigil-sentinel status')}>
                    @vigil-sentinel status
                  </button>
                  <button type="button" className="wr-chipbtn" onClick={() => setChatInput('@vigil-patcher show diff')}>
                    @vigil-patcher show diff
                  </button>
                  <button
                    type="button"
                    className="wr-chipbtn"
                    onClick={() => {
                      setSelectedRoomId(snap.roomIds.releasesRoomId);
                      setChatInput('@vigil-release-gate policy');
                    }}
                  >
                    @vigil-release-gate policy
                  </button>
                  <button
                    type="button"
                    className="wr-chipbtn wr-chipbtn--warn"
                    onClick={() => {
                      setSelectedRoomId(snap.roomIds.releasesRoomId);
                      setChatInput('@vigil-release-gate set max diff 1');
                    }}
                    title="Tighten the room policy from chat so the staged patch is rejected on the next approval"
                  >
                    set max diff 1
                  </button>
                  {activeInc && (
                    <button
                      type="button"
                      className="wr-chipbtn wr-chipbtn--brand"
                      onClick={() => {
                        setSelectedRoomId(snap.roomIds.releasesRoomId);
                        setChatInput(`@vigil-release-gate approve ${activeInc.incidentId} promote`);
                      }}
                    >
                      approve {activeInc.incidentId} promote
                    </button>
                  )}
                </div>
                <div className="wr-inputrow">
                  <select
                    className="wr-select"
                    value={operatorHandle}
                    onChange={(e) => setOperatorHandle(e.target.value)}
                    aria-label="Post as"
                  >
                    <option value="priya">Priya (test identity)</option>
                    <option value="sam">Sam (test identity)</option>
                  </select>
                  <input
                    type="text"
                    className="wr-input"
                    value={chatInput}
                    onChange={(e) => setChatInput(e.target.value)}
                    placeholder={`Message #${currentRoom.name} as @switch-user-${operatorHandle}`}
                    aria-label="Message"
                  />
                  <button type="submit" className="wr-btn wr-btn--dark" disabled={!chatInput.trim()}>
                    <Send className="wr-ic" />
                    <span>Send</span>
                  </button>
                </div>
              </form>
              )}
            </>
          )}
        </section>

        {/* ───────────── Right: documents, wire, patch & canary ───────────── */}
        <section className="wr-col wr-right">
          <nav className="wr-tabs" aria-label="Inspector">
            <button type="button" className={`wr-tab ${rightTab === 'docs' ? 'is-on' : ''}`} onClick={() => setRightTab('docs')}>
              Room Docs <small>{allDocuments.length}</small>
            </button>
            <button type="button" className={`wr-tab ${rightTab === 'wire' ? 'is-on' : ''}`} onClick={() => setRightTab('wire')}>
              WS Protocol <small>{snap.wireTraces.length}</small>
            </button>
            <button type="button" className={`wr-tab ${rightTab === 'patch' ? 'is-on' : ''}`} onClick={() => setRightTab('patch')}>
              Patch &amp; Canary
              {latestInc && <span className={`wr-sq ${latestInc.canaryReport ? '' : gateInc ? 'wr-sq--warn is-pulse' : 'wr-sq--idle'}`} />}
            </button>
          </nav>

          {rightTab === 'docs' && (
            <div className="wr-pane">
              <div className="wr-pills">
                {allDocuments.map((d) => (
                  <button
                    key={`${d.roomId}:${d.name}`}
                    type="button"
                    className={`wr-chipbtn ${activeDoc?.name === d.name ? 'is-on' : ''}`}
                    onClick={() => setSelectedDocName(d.name)}
                  >
                    {d.name}
                  </button>
                ))}
              </div>
              {activeDoc ? (
                <div className="wr-block">
                  <div className="wr-docmeta">
                    <span>#{activeDoc.roomName}</span>
                    <span>by {activeDoc.created_by_name}</span>
                  </div>
                  {activeDoc.description && (
                    <p style={{ margin: '0 0 10px', fontSize: 13, color: 'var(--soft)' }}>{activeDoc.description}</p>
                  )}
                  <pre className="vl-code wr-code wr-code--wrap">{activeDoc.content}</pre>
                </div>
              ) : (
                <div className="wr-empty">No room documents yet.</div>
              )}
            </div>
          )}

          {rightTab === 'wire' && (
            <div className="wr-pane">
              <p>
                Live Switch Agent Protocol frames: <span className="wr-code-inline">connection_state</span>,{' '}
                <span className="wr-code-inline">ping/pong</span> cursors, <span className="wr-code-inline">message</span>, and
                ops sent with <span className="wr-code-inline">X-Switch-Connection-Id</span>.
              </p>
              <div className="wr-rows">
                {snap.wireTraces.map((t) => (
                  <div key={t.id} className="wr-wire">
                    <div className="wr-wire-top">
                      <span
                        className={`wr-tag ${
                          t.direction === 'http_op' ? 'wr-tag--warn' : t.direction === 'outbound' ? 'wr-tag--ink' : 'wr-tag--brand'
                        }`}
                      >
                        {t.frameType}
                      </span>
                      <span className="wr-wire-agent">{t.agentName}</span>
                    </div>
                    <div className="wr-wire-sum">{t.summary}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {rightTab === 'patch' && (
            <div className="wr-pane">
              {/* Release policy, read live from the release-safety-policy room document */}
              <div className="wr-card">
                <div className="wr-card-h">
                  <h3 className="wr-card-title">
                    <Scale className="wr-ic" />
                    Release policy
                  </h3>
                  <span className="wr-label">room doc · humans edit via chat</span>
                </div>
                <div className="wr-kv">
                  <div>
                    <small>max changed lines</small>
                    <b>{policy.maxChangedLines}</b>
                  </div>
                  <div>
                    <small>green matrix</small>
                    <b>{policy.requireGreenMatrix ? 'required' : 'off'}</b>
                  </div>
                  <div>
                    <small>canary probes</small>
                    <b>{policy.minCanaryProbes}</b>
                  </div>
                  <div>
                    <small>approvers</small>
                    <b title={policy.allowedApprovers.join(', ')}>{policy.allowedApprovers.join(', ')}</b>
                  </div>
                  <div className="is-wide">
                    <small>forbidden paths</small>
                    <b title={policy.forbiddenPaths.join(', ')}>{policy.forbiddenPaths.join(', ') || 'none'}</b>
                  </div>
                </div>
                {snap.policyAudit.length > 0 && (
                  <div className="wr-rows wr-audit">
                    {snap.policyAudit
                      .slice(-4)
                      .reverse()
                      .map((a) => (
                        <div key={a.at} className="wr-row wr-row--log">
                          <span className={`wr-sq ${a.accepted ? '' : 'wr-sq--alert'}`} />
                          <span>
                            {a.senderName}: {a.summary}
                          </span>
                        </div>
                      ))}
                  </div>
                )}
              </div>

              {/* External coder intake */}
              {latestInc && latestInc.patchMode === 'external' && !latestInc.canaryReport && !latestInc.patchVerification?.allPassed && (
                <div className="wr-card wr-card--ext">
                  <div className="wr-card-h">
                    <h3 className="wr-card-title">
                      <Upload className="wr-ic" />
                      External patch intake
                    </h3>
                    <span className="wr-tag wr-tag--violet">
                      {latestInc.incidentId} · @{snap.externalCoderHandle}
                    </span>
                  </div>
                  <p>
                    Claude Code, or any coding agent in #vigil-hotfix, hands its unified diff to{' '}
                    <span className="wr-code-inline">@vigil-patcher</span> in a diff fence or with{' '}
                    <span className="wr-code-inline">POST /api/incidents/{latestInc.incidentId}/stage-patch</span>. Vigil verifies
                    it. A diff without the fix is rejected.
                  </p>
                  <div className="wr-intake-actions">
                    <input
                      className="wr-input wr-input--sm"
                      value={externalAuthor}
                      onChange={(e) => setExternalAuthor(e.target.value)}
                      placeholder="author handle"
                      aria-label="Author handle"
                    />
                    <button type="button" className="wr-chipbtn" style={{ height: 32 }} onClick={() => loadReferenceFix(latestInc.incidentId)}>
                      Load reference fix
                    </button>
                    <button
                      type="button"
                      className="wr-chipbtn wr-chipbtn--alert"
                      style={{ height: 32 }}
                      onClick={() =>
                        setExternalDiff(
                          'diff --git a/src/NOTES.md b/src/NOTES.md\nnew file mode 100644\n--- /dev/null\n+++ b/src/NOTES.md\n@@ -0,0 +1 @@\n+A note only. This change applies cleanly but does not fix the fault.\n',
                        )
                      }
                      title="A diff that applies cleanly but does not fix the fault: the verifier must reject it"
                    >
                      Load bad diff
                    </button>
                  </div>
                  <textarea
                    className="wr-textarea"
                    value={externalDiff}
                    onChange={(e) => setExternalDiff(e.target.value)}
                    rows={8}
                    spellCheck={false}
                    placeholder={'--- a/src/cartPricing.ts\n+++ b/src/cartPricing.ts\n@@ ... @@\n+  JPY: { minorScale: 1 },'}
                  />
                  <div className="wr-intake-foot">
                    <span>{stageResult}</span>
                    <button
                      type="button"
                      className="wr-btn wr-btn--violet"
                      disabled={busy || !externalDiff.trim()}
                      onClick={() => submitExternalPatch(latestInc.incidentId)}
                    >
                      <Upload className="wr-ic" />
                      <span>Submit to @vigil-patcher</span>
                    </button>
                  </div>
                </div>
              )}

              {!latestInc ? (
                <div className="wr-empty">
                  Ship a chaos release from the bar above. This tab then shows the real reproduction, the candidate diff, the
                  test matrix, the gate decisions and the canary probes.
                </div>
              ) : (
                <>
                  <div className="wr-card">
                    <div className="wr-inc-top">
                      <span className="wr-inc-id">{latestInc.incidentId}</span>
                      <span className={`wr-tag ${stageTone(latestInc.stage)}`}>{latestInc.stage.replace(/_/g, ' ')}</span>
                    </div>
                    <h3 className="wr-inc-title">{latestInc.title}</h3>
                    <div className="wr-inc-meta">
                      <span className="wr-tag">commit {latestInc.alert.suspectedCommit.sha}</span>
                      <span className={`wr-tag ${latestInc.patchMode === 'external' ? 'wr-tag--violet' : 'wr-tag--brand'}`}>
                        {latestInc.patchMode === 'external' ? `@${snap.externalCoderHandle} · verified by vigil-patcher` : 'vigil-patcher'}
                      </span>
                      {pv && <span className="wr-tag">author {pv.author}</span>}
                      {latestInc.workroom && (
                        <button
                          type="button"
                          className={`wr-tag ${latestInc.workroom.archived ? '' : 'wr-tag--violet'}`}
                          onClick={() => openRoom(latestInc.workroom!.roomId)}
                        >
                          <Archive className="wr-ic" />#{latestInc.workroom.roomName} · {latestInc.workroom.archived ? 'archived' : 'open'}
                        </button>
                      )}
                    </div>
                  </div>

                  {pv && (
                    <>
                      <div className="wr-block">
                        <div className="wr-h3">
                          <span className="wr-label">
                            <b>Candidate diff</b>
                          </span>
                          <span className="wr-label">
                            {pv.candidateVersion}
                            {pv.candidateSha ? ` @ ${pv.candidateSha}` : ' · discarded'}
                          </span>
                        </div>
                        <DiffBlock diff={pv.diffUnified} />
                      </div>

                      <div className="wr-block">
                        <div className="wr-h3">
                          <span className="wr-label">
                            <b>Regression matrix</b>
                          </span>
                          <span className={`wr-tag ${pv.allPassed ? 'wr-tag--brand' : 'wr-tag--alert'}`}>
                            {pv.testMatrix.filter((t) => t.passed).length}/{pv.testMatrix.length} green
                          </span>
                        </div>
                        <div className="wr-rows wr-matrix">
                          {pv.testMatrix.map((vec) => (
                            <div key={vec.name} className={`wr-row ${vec.passed ? '' : 'is-fail'}`}>
                              <span className={`wr-sq ${vec.passed ? '' : 'wr-sq--alert'}`} />
                              <div>
                                <div className="wr-matrix-name">{vec.name}</div>
                                <div className="wr-matrix-detail">{vec.detail}</div>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>

                      <div className="wr-block">
                        <div className="wr-h3">
                          <span className="wr-label">
                            <b>Real test run</b>
                          </span>
                          <span className="wr-label">node --test · TAP</span>
                        </div>
                        <pre className="vl-code wr-code wr-code--wrap wr-code--short">
                          {pv.testRunOutput.trim().split('\n').slice(-20).join('\n')}
                        </pre>
                      </div>
                    </>
                  )}

                  {latestInc.gateDecisions.length > 0 && (
                    <div className="wr-block">
                      <div className="wr-h3">
                        <span className="wr-label">
                          <b>Release gate decisions</b>
                        </span>
                        <span className="wr-label">deterministic</span>
                      </div>
                      <div className="wr-rows">
                        {latestInc.gateDecisions.map((gd, idx) => (
                          <div key={idx} className={`wr-decision ${gd.allowed ? '' : 'is-deny'}`}>
                            <b>{gd.reasonCode}</b>
                            <span>{gd.explanation}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {latestInc.canaryReport && (
                    <div className="wr-block">
                      <div className="wr-h3">
                        <span className="wr-label">
                          <b>Post-deploy canary</b>
                        </span>
                        <span className={`wr-tag ${latestInc.canaryReport.healthy ? 'wr-tag--brand' : 'wr-tag--alert'}`}>
                          {latestInc.canaryReport.probesPassed} of {latestInc.canaryReport.probesRun} passed
                        </span>
                      </div>
                      <pre className="vl-code wr-code wr-code--wrap">
                        {latestInc.canaryReport.details.map((line, i) => (
                          <span key={i} className={/\bOK\b/.test(line) ? 'ok' : 'no'}>
                            {line}
                            {'\n'}
                          </span>
                        ))}
                      </pre>
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </section>
      </main>

      {notice && (
        <div className="wr-toast" role="status">
          <span>{notice}</span>
          <button type="button" aria-label="Dismiss" onClick={() => setNotice(null)}>
            <X className="wr-ic" />
          </button>
        </div>
      )}

      {/* ───────────── Switch template modal ───────────── */}
      {showTemplateModal && (
        <div className="wr-modal-bg" onClick={() => setShowTemplateModal(false)}>
          <div className="wr-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <div className="wr-modal-h">
              <div>
                <span className="wr-label">templates/vigil-war-room.template.yaml</span>
                <h2>Switch group template</h2>
                <p>
                  Import into Switch Console under Templates to provision the three linked rooms, roles, documents and agents
                  in Mattermost, Discord, Telegram or Slack.
                </p>
              </div>
              <div>
                <button
                  type="button"
                  className="wr-btn wr-btn--dark"
                  onClick={() => {
                    navigator.clipboard.writeText(templateYaml);
                    setCopiedYaml(true);
                    setTimeout(() => setCopiedYaml(false), 2000);
                  }}
                >
                  <Copy className="wr-ic" />
                  <span>{copiedYaml ? 'Copied' : 'Copy YAML'}</span>
                </button>
                <button type="button" className="wr-btn" onClick={() => setShowTemplateModal(false)}>
                  <X className="wr-ic" />
                  <span>Close</span>
                </button>
              </div>
            </div>
            <pre className="vl-code">{templateYaml}</pre>
          </div>
        </div>
      )}
    </div>
  );
}

const FAULTS = [
  { id: 'jpy_zero_decimal_500', n: '01', label: 'JPY Zero-Decimal 500', tone: 'alert' },
  { id: 'promo_negative_ledger_500', n: '02', label: 'Stacked Promo Negative 500', tone: 'warn' },
  { id: 'inventory_lock_leak_503', n: '03', label: 'Inventory Lock Leak 503', tone: 'violet' },
] as const;

/**
 * Chat Markdown as agents write it: **bold**, *italic*, `code`, and "- " bullet lists. Builds React
 * elements (never raw HTML), so nothing in a message can inject markup.
 */
function MessageBody({ text }: { text: string }) {
  // Fenced blocks (```diff … ```) are code, not prose: split them out first.
  const parts = text.replace(/\s+$/, '').split(/^```([a-z]*)[ \t]*\n([\s\S]*?)^```[ \t]*$/m);
  if (parts.length > 1) {
    const out: React.ReactNode[] = [];
    for (let i = 0; i < parts.length; i += 3) {
      if (parts[i].trim()) out.push(<MessageBody key={`t${i}`} text={parts[i]} />);
      if (i + 2 < parts.length) {
        const lang = parts[i + 1];
        const code = parts[i + 2].replace(/\n$/, '');
        out.push(
          lang === 'diff' ? (
            <DiffBlock key={`c${i}`} diff={code} />
          ) : (
            <pre key={`c${i}`} className="vl-code wr-code">
              {code}
            </pre>
          ),
        );
      }
    }
    return <div className="wr-msg-body">{out}</div>;
  }
  const blocks: Array<{ list: boolean; lines: string[] }> = [];
  for (const line of text.replace(/\s+$/, '').split('\n')) {
    const bullet = /^\s*[-*]\s+/.test(line);
    const last = blocks[blocks.length - 1];
    if (last && last.list === bullet && (bullet || line.trim() !== '')) last.lines.push(line);
    else if (line.trim() !== '' || bullet) blocks.push({ list: bullet, lines: [line] });
  }
  return (
    <div className="wr-msg-body">
      {blocks.map((b, i) =>
        b.list ? (
          <ul key={i}>
            {b.lines.map((l, j) => (
              <li key={j}>{inlineMarkdown(l.replace(/^\s*[-*]\s+/, ''))}</li>
            ))}
          </ul>
        ) : (
          <p key={i}>
            {b.lines.map((l, j) => (
              <React.Fragment key={j}>
                {j > 0 && <br />}
                {inlineMarkdown(l)}
              </React.Fragment>
            ))}
          </p>
        ),
      )}
    </div>
  );
}

/** Switch's one-line room notices, e.g. "assumed the `patch-author` role", "created room document …". */
const ROOM_NOTICE = /^(assumed|released) the `[^`]+` role\.?$|^(created|updated) room document\b/i;

/** Drop emoji and other pictographs (and the spacing they leave), for agent and Switch messages. */
function withoutPictographs(text: string): string {
  return text
    .replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, '')
    .replace(/^[ \t]+/gm, '')
    .trim();
}

function inlineMarkdown(line: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*\s][^*]*\*)/g;
  let at = 0;
  for (const m of line.matchAll(re)) {
    const idx = m.index ?? 0;
    if (idx > at) out.push(line.slice(at, idx));
    const tok = m[0];
    if (tok.startsWith('`')) out.push(<code key={idx}>{tok.slice(1, -1)}</code>);
    else if (tok.startsWith('**')) out.push(<strong key={idx}>{inlineMarkdown(tok.slice(2, -2))}</strong>);
    else out.push(<em key={idx}>{tok.slice(1, -1)}</em>);
    at = idx + tok.length;
  }
  if (at < line.length) out.push(line.slice(at));
  return out;
}

function stageTone(stage: string): string {
  if (stage === 'resolved_promoted') return 'wr-tag--brand';
  if (stage === 'resolved_rolled_back') return '';
  if (stage === 'interrupted') return '';
  if (stage === 'awaiting_human_gate') return 'wr-tag--warn';
  if (stage === 'reproducing_patching') return 'wr-tag--violet';
  return 'wr-tag--alert';
}

/** Unified diff with added and removed lines coloured, on the landing page's dark code surface. */
function DiffBlock({ diff }: { diff: string }) {
  return (
    <pre className="vl-code wr-code">
      {diff.split('\n').map((line, i) => {
        const cls =
          line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ')
            ? 'c'
            : line.startsWith('@@')
              ? 'p'
              : line.startsWith('+')
                ? 'ok'
                : line.startsWith('-')
                  ? 'no'
                  : undefined;
        return (
          <span key={i} className={cls}>
            {line}
            {'\n'}
          </span>
        );
      })}
    </pre>
  );
}
