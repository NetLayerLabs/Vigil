import React, { useEffect, useState } from 'react';
import {
  Activity,
  ArrowRight,
  Bot,
  CheckCircle2,
  Code2,
  FileText,
  Flame,
  GitBranch,
  Link2,
  Lock,
  Network,
  Play,
  Radio,
  Rocket,
  ShieldAlert,
  ShieldCheck,
  Terminal,
  UserCheck,
  Zap,
} from 'lucide-react';

interface LiveStatus {
  mode: string;
  agentsOnline: number;
  agentsTotal: number;
  roomCount: number;
  deployedVersion: string;
  status: 'healthy' | 'degraded';
  errorRatePct: number;
}

export function Landing({ onLaunch }: { onLaunch: () => void }) {
  const [live, setLive] = useState<LiveStatus | null>(null);

  useEffect(() => {
    let active = true;
    fetch('/api/state')
      .then((r) => r.json())
      .then((snap) => {
        if (!active) return;
        const agents = snap?.switchState?.agents ?? [];
        setLive({
          mode: snap.mode,
          agentsOnline: agents.filter((a: { online: boolean }) => a.online).length,
          agentsTotal: agents.length,
          roomCount: snap?.switchState?.rooms?.length ?? 0,
          deployedVersion: snap?.checkoutTelemetry?.deployedVersion ?? '—',
          status: snap?.checkoutTelemetry?.status ?? 'healthy',
          errorRatePct: snap?.checkoutTelemetry?.errorRatePct ?? 0,
        });
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 relative overflow-x-hidden">
      {/* Ambient background */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -top-40 left-1/2 -translate-x-1/2 w-[900px] h-[500px] rounded-full bg-emerald-500/10 blur-3xl" />
        <div className="absolute top-[40%] -right-40 w-[600px] h-[400px] rounded-full bg-indigo-500/10 blur-3xl" />
        <div
          className="absolute inset-0 opacity-[0.07]"
          style={{
            backgroundImage:
              'linear-gradient(rgba(148,163,184,0.5) 1px, transparent 1px), linear-gradient(90deg, rgba(148,163,184,0.5) 1px, transparent 1px)',
            backgroundSize: '48px 48px',
            maskImage: 'radial-gradient(ellipse at top, black 30%, transparent 75%)',
            WebkitMaskImage: 'radial-gradient(ellipse at top, black 30%, transparent 75%)',
          }}
        />
      </div>

      {/* Nav */}
      <header className="relative z-10 max-w-7xl mx-auto px-6 py-5 flex items-center justify-between gap-4">
        <a href="/" className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-emerald-500/15 border border-emerald-500/40 flex items-center justify-center">
            <ShieldCheck className="w-5 h-5 text-emerald-400" />
          </div>
          <div className="leading-tight">
            <div className="font-semibold tracking-tight text-white">VIGIL</div>
            <div className="text-[11px] font-mono text-slate-400">Incident-to-Hotfix War Room on Switch</div>
          </div>
        </a>

        <nav className="hidden md:flex items-center gap-6 text-sm text-slate-300">
          <a href="#pipeline" className="hover:text-white transition">Pipeline</a>
          <a href="#primitives" className="hover:text-white transition">Switch Primitives</a>
          <a href="#demo" className="hover:text-white transition">Demo</a>
          <a href="#quickstart" className="hover:text-white transition">Quickstart</a>
        </nav>

        <button
          onClick={onLaunch}
          className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-semibold flex items-center gap-2 shadow-lg shadow-emerald-900/40 transition"
        >
          <Rocket className="w-4 h-4" />
          Launch App
        </button>
      </header>

      {/* Hero */}
      <section className="relative z-10 max-w-7xl mx-auto px-6 pt-12 pb-20 grid lg:grid-cols-12 gap-12 items-center">
        <div className="lg:col-span-6">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 text-emerald-300 text-xs font-mono mb-6">
            <Zap className="w-3.5 h-3.5" />
            Flip the Switch Hackathon · Track 01: Best Business Workflow
          </div>

          <h1 className="text-4xl sm:text-5xl lg:text-6xl font-semibold tracking-tight text-white leading-[1.05]">
            Turn SEV-1 outages into a{' '}
            <span className="text-transparent bg-clip-text bg-gradient-to-r from-emerald-300 via-emerald-400 to-teal-300">
              human-governed
            </span>{' '}
            war room.
          </h1>

          <p className="mt-6 text-lg text-slate-300 leading-relaxed max-w-xl">
            Vigil wires three linked Switch Rooms into your team chat. Autonomous agents triage the
            stack trace, reproduce the bug, stage a surgical patch, and then stop. A real human
            approves the release in Mattermost, Discord, Telegram, or Slack. Nothing ships without
            them.
          </p>

          <div className="mt-8 flex flex-wrap items-center gap-3">
            <button
              onClick={onLaunch}
              className="px-6 py-3 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-semibold flex items-center gap-2 shadow-xl shadow-emerald-900/40 transition text-base"
            >
              <Rocket className="w-5 h-5" />
              Launch App
              <ArrowRight className="w-4 h-4" />
            </button>
            <a
              href="#demo"
              className="px-6 py-3 rounded-xl bg-slate-900 hover:bg-slate-800 border border-slate-700 text-slate-200 font-medium flex items-center gap-2 transition"
            >
              <Play className="w-4 h-4 text-emerald-400" />
              See the 4-click demo
            </a>
          </div>

          <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-2 text-xs font-mono text-slate-400">
            <span className="flex items-center gap-1.5">
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" /> Switch WebSocket Agent Protocol
            </span>
            <span className="flex items-center gap-1.5">
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" /> Switch v1 Group Templates
            </span>
            <span className="flex items-center gap-1.5">
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" /> Zero-LLM release gate
            </span>
          </div>
        </div>

        {/* Live mesh preview */}
        <div className="lg:col-span-6">
          <div className="rounded-2xl border border-slate-800 bg-slate-900/70 backdrop-blur shadow-2xl shadow-black/50 overflow-hidden">
            <div className="px-4 py-2.5 border-b border-slate-800 flex items-center justify-between bg-slate-900/90">
              <div className="flex items-center gap-2 text-xs font-mono text-slate-400">
                <span className="w-2.5 h-2.5 rounded-full bg-rose-500/70" />
                <span className="w-2.5 h-2.5 rounded-full bg-amber-500/70" />
                <span className="w-2.5 h-2.5 rounded-full bg-emerald-500/70" />
                <span className="ml-2">vigil-war-room.template.yaml</span>
              </div>
              <div className="flex items-center gap-1.5 text-[11px] font-mono">
                {live ? (
                  <>
                    <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                    <span className="text-emerald-300">
                      {live.agentsOnline}/{live.agentsTotal} agents connected
                    </span>
                  </>
                ) : (
                  <>
                    <Radio className="w-3 h-3 text-slate-500 animate-pulse" />
                    <span className="text-slate-500">connecting…</span>
                  </>
                )}
              </div>
            </div>

            <div className="p-5 space-y-3">
              <RoomRow
                name="vigil-incidents"
                role="incident-commander"
                agent="vigil-sentinel"
                doc="blast-radius-dossier"
                desc="Correlates the 5xx stack trace to the suspect commit and claims the exclusive lease."
                accent="rose"
              />
              <LinkRow label="escalates reproduction & patch request" />
              <RoomRow
                name="vigil-hotfix"
                role="patch-author"
                agent="vigil-patcher"
                doc="patch-verification-report"
                desc="Reproduces the TypeError, stages a <40-line diff, passes the 5-vector regression matrix."
                accent="amber"
              />
              <LinkRow label="stages verified diff for human sign-off" />
              <RoomRow
                name="vigil-releases"
                role="release-gatekeeper"
                agent="vigil-release-gate"
                doc="postmortem-inc-xxxx"
                desc="Rejects agent self-approvals. Promotes only on a human's approve command, then runs canary probes."
                accent="emerald"
              />
            </div>

            <div className="px-5 py-3 border-t border-slate-800 bg-slate-950/60 flex flex-wrap items-center justify-between gap-2 text-[11px] font-mono">
              <span className="flex items-center gap-1.5 text-slate-400">
                <Activity className="w-3.5 h-3.5 text-emerald-400" />
                checkout-api {live ? live.deployedVersion : 'v2.13.2'}
              </span>
              <span
                className={
                  live?.status === 'degraded' ? 'text-rose-300' : 'text-emerald-300'
                }
              >
                {live
                  ? live.status === 'degraded'
                    ? `DEGRADED · 5xx ${live.errorRatePct}%`
                    : 'HEALTHY · 5xx 0%'
                  : 'HEALTHY · 5xx 0%'}
              </span>
              <span className="text-slate-500">
                {live?.mode === 'live_switch_console_server'
                  ? 'Switch Console · Live Bridge'
                  : 'Switch WS Protocol · Embedded Bridge'}
              </span>
            </div>
          </div>
        </div>
      </section>

      {/* Problem strip */}
      <section className="relative z-10 border-y border-slate-800/80 bg-slate-900/40">
        <div className="max-w-7xl mx-auto px-6 py-10 grid md:grid-cols-3 gap-6 text-sm">
          <Problem
            icon={<Terminal className="w-4 h-4 text-rose-400" />}
            title="Solo coding agents go dark"
            body="One engineer's agent fixes a bug locally. The on-call lead sees nothing until it lands in production."
          />
          <Problem
            icon={<Lock className="w-4 h-4 text-amber-400" />}
            title="Nobody holds command"
            body="Two responders triage the same alert, two agents stage conflicting patches, and nobody knows what was verified."
          />
          <Problem
            icon={<ShieldAlert className="w-4 h-4 text-purple-400" />}
            title="Agents with deploy keys"
            body="An autonomous agent with credentials can approve its own release. That is a prompt injection away from an outage."
          />
        </div>
      </section>

      {/* Pipeline */}
      <section id="pipeline" className="relative z-10 max-w-7xl mx-auto px-6 py-20">
        <SectionHeading
          eyebrow="The workflow"
          title="Three linked rooms. One auditable incident lifecycle."
          body="Each stage of an outage lives in its own Switch Room with an exclusive role lease, a room-scoped document, and a directed link to the next room. Agents discover the next hop at runtime instead of hardcoding channel IDs."
        />

        <div className="mt-12 grid md:grid-cols-3 gap-5">
          <StageCard
            step="01"
            room="#vigil-incidents"
            agent="@vigil-sentinel"
            role="incident-commander"
            doc="blast-radius-dossier"
            accent="rose"
            points={[
              'Receives the HTTP 500/503 webhook from checkout-api',
              'Correlates the stack trace to the suspect v2.14.0 commit',
              'Claims the exclusive incident-commander lease',
              'Publishes the blast-radius dossier and escalates over the room link',
            ]}
          />
          <StageCard
            step="02"
            room="#vigil-hotfix"
            agent="@vigil-patcher"
            role="patch-author"
            doc="patch-verification-report"
            accent="amber"
            points={[
              'Reproduces the exact failing payload against the live API',
              'Stages a surgical diff under 40 lines',
              'Runs the 5-vector regression matrix to green',
              'Writes the verification report and hands off to releases',
            ]}
          />
          <StageCard
            step="03"
            room="#vigil-releases"
            agent="@vigil-release-gate"
            role="release-gatekeeper"
            doc="postmortem-inc-xxxx"
            accent="emerald"
            points={[
              'Deterministically rejects any @switch-agent-* approval',
              'Waits for a human approve <INC> promote or rollback',
              'Promotes the hotfix and runs 5 live HTTP canary probes',
              'Publishes the blameless postmortem and closes the incident',
            ]}
          />
        </div>
      </section>

      {/* Switch primitives */}
      <section id="primitives" className="relative z-10 border-y border-slate-800/80 bg-slate-900/30">
        <div className="max-w-7xl mx-auto px-6 py-20">
          <SectionHeading
            eyebrow="Why Switch"
            title="Built on native Switch primitives, end to end."
            body="Vigil is not a chatbot bolted onto a channel. Remove Switch and the workflow stops working."
          />

          <div className="mt-12 grid sm:grid-cols-2 lg:grid-cols-3 gap-5">
            <Primitive
              icon={<Code2 className="w-5 h-5 text-emerald-400" />}
              title="v1 Group & Room Templates"
              body="One YAML file provisions all three rooms, three agents, exclusive roles, room documents, aliases, kickoffs, and directed links."
            />
            <Primitive
              icon={<Radio className="w-5 h-5 text-indigo-400" />}
              title="WebSocket Agent Protocol"
              body="Custom client over /agents/{id}/connection/ws with 2s ping/pong cursors, generation fencing, gap recovery, and taken_over eviction."
            />
            <Primitive
              icon={<Lock className="w-5 h-5 text-amber-400" />}
              title="Exclusive Role Leases"
              body="assume_role and release_role give single-writer leases on incident-commander, patch-author, and release-gatekeeper."
            />
            <Primitive
              icon={<FileText className="w-5 h-5 text-sky-400" />}
              title="Room-Scoped Documents"
              body="Dossier, verification report, and postmortem are written as Switch Room Documents with enforced authorship."
            />
            <Primitive
              icon={<Link2 className="w-5 h-5 text-teal-400" />}
              title="Directed Room Links"
              body="Agents call list_linked_rooms to find the next stage dynamically. No channel IDs in code."
            />
            <Primitive
              icon={<UserCheck className="w-5 h-5 text-rose-400" />}
              title="Deterministic Human Gate"
              body="Zero-LLM gate: only a verified @switch-user-* teammate can promote or roll back. Agent self-approvals return REJECTED_AGENT_SENDER."
            />
          </div>

          <div className="mt-14 grid md:grid-cols-2 gap-5">
            <Differentiator
              tag="Your agent, verified"
              title="Claude Code writes the fix. Vigil checks it."
              body="Bind the coding agent you already use into #vigil-hotfix through Switch Console. Vigil's patcher steps back into the red-team-verifier seat, reproduces independently, and runs the regression matrix on the diff your agent actually wrote. A diff without the fix is rejected before it reaches the gate."
            />
            <Differentiator
              tag="Governance in the room"
              title="Release policy is a Switch room document."
              body="The gate re-reads release-safety-policy on every approval. Type `set max diff 4` or `set approvers sam` in chat and the next decision follows the new rules. Agents that try to edit policy are blocked."
            />
            <Differentiator
              tag="Lease failover"
              title="Crash the incident commander. Nothing is lost."
              body="A wedged sentinel is evicted with taken_over. A standby reopens the same connection_id from the last cursor, picks up a new generation, and re-asserts the exclusive incident-commander lease mid-incident."
            />
            <Differentiator
              tag="Rooms with a lifecycle"
              title="One ephemeral workroom per incident."
              body="Each SEV-1 gets a #hotfix-inc-xxxx red/blue room created from a Switch template, linked from #vigil-hotfix, and archived at closure. Rooms become part of the audit trail instead of static channels."
            />
          </div>
        </div>
      </section>

      {/* Demo steps */}
      <section id="demo" className="relative z-10 max-w-7xl mx-auto px-6 py-20">
        <SectionHeading
          eyebrow="Try it"
          title="The full incident, in four clicks."
          body="The app ships with a live checkout-api target, three chaos scenarios, and an embedded spec-exact Switch protocol server. No external setup required."
        />

        <div className="mt-12 grid md:grid-cols-2 lg:grid-cols-4 gap-5">
          <DemoStep
            n={1}
            icon={<Flame className="w-5 h-5 text-rose-400" />}
            title="Inject a chaos release"
            body="Deploy a buggy v2.14.0. Pick JPY zero-decimal 500, stacked promo negative 500, or inventory lock leak 503."
          />
          <DemoStep
            n={2}
            icon={<Bot className="w-5 h-5 text-indigo-400" />}
            title="Watch the relay"
            body="Sentinel, patcher, and release gate collaborate across the three rooms over real WebSocket frames."
          />
          <DemoStep
            n={3}
            icon={<ShieldAlert className="w-5 h-5 text-amber-400" />}
            title="Test the rogue agent block"
            body="An agent tries to approve its own release. The gate rejects it and production stays untouched."
          />
          <DemoStep
            n={4}
            icon={<UserCheck className="w-5 h-5 text-emerald-400" />}
            title="Approve as Priya"
            body="Type approve INC-2041 promote. Watch the hotfix ship, 5/5 canary probes pass, and the postmortem publish."
          />
        </div>

        <div className="mt-10 flex justify-center">
          <button
            onClick={onLaunch}
            className="px-7 py-3.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-semibold flex items-center gap-2 shadow-xl shadow-emerald-900/40 transition"
          >
            <Rocket className="w-5 h-5" />
            Launch the War Room
            <ArrowRight className="w-4 h-4" />
          </button>
        </div>
      </section>

      {/* Quickstart */}
      <section id="quickstart" className="relative z-10 border-t border-slate-800/80 bg-slate-900/30">
        <div className="max-w-7xl mx-auto px-6 py-20 grid lg:grid-cols-2 gap-12 items-start">
          <div>
            <SectionHeading
              eyebrow="Quickstart"
              title="Clone, test, run. Thirty seconds."
              body="Mode A boots the embedded Switch protocol server for an instant, reproducible demo. Mode B connects the same agents to your live Switch Console and team chat."
              align="left"
            />
            <ul className="mt-8 space-y-3 text-sm text-slate-300">
              <li className="flex items-start gap-2.5">
                <GitBranch className="w-4 h-4 text-emerald-400 mt-0.5 shrink-0" />
                <span>
                  <span className="text-white font-medium">Mode A, embedded:</span> leave{' '}
                  <code className="font-mono text-emerald-300">SWITCH_SERVER_URL</code> empty and the
                  built-in spec-exact Switch server starts with the app.
                </span>
              </li>
              <li className="flex items-start gap-2.5">
                <Network className="w-4 h-4 text-indigo-400 mt-0.5 shrink-0" />
                <span>
                  <span className="text-white font-medium">Mode B, live:</span> onboard the three
                  agents with <code className="font-mono text-indigo-300">npm run onboard:switch</code>,
                  import the YAML template in Switch Console, and approve releases from chat.
                </span>
              </li>
              <li className="flex items-start gap-2.5">
                <CheckCircle2 className="w-4 h-4 text-emerald-400 mt-0.5 shrink-0" />
                <span>
                  <span className="text-white font-medium">Verified:</span> the Vitest suite covers the
                  protocol handshake, role lease contention, document authorship, rogue-agent rejection,
                  and the full promote and rollback path.
                </span>
              </li>
            </ul>
          </div>

          <div className="rounded-2xl border border-slate-800 bg-slate-950 shadow-2xl overflow-hidden">
            <div className="px-4 py-2.5 border-b border-slate-800 flex items-center gap-2 text-xs font-mono text-slate-400">
              <Terminal className="w-3.5 h-3.5 text-emerald-400" />
              terminal
            </div>
            <pre className="p-5 font-mono text-[13px] leading-relaxed text-slate-200 overflow-x-auto">
{`$ git clone https://github.com/mrnetwork0001/Vigil.git && cd Vigil
$ npm install
$ npm test        # 4/4 protocol, chaos & gate tests
$ npm run build
$ npm start

⚡ Vigil — Autonomous Incident-to-Hotfix War Room
• Observatory & API   : http://localhost:4010
• Checkout API Target : http://localhost:4020/health
• Linked Switch Rooms : #vigil-incidents -> #vigil-hotfix -> #vigil-releases`}
            </pre>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="relative z-10 border-t border-slate-800/80">
        <div className="max-w-7xl mx-auto px-6 py-8 flex flex-wrap items-center justify-between gap-4 text-xs text-slate-500">
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-emerald-500" />
            <span className="font-mono">Vigil · MIT License · Built for the Flip the Switch Hackathon by WeMakeDevs & Switch AI</span>
          </div>
          <button
            onClick={onLaunch}
            className="px-3 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-700 text-slate-200 flex items-center gap-1.5 transition"
          >
            <Rocket className="w-3.5 h-3.5 text-emerald-400" />
            Launch App
          </button>
        </div>
      </footer>
    </div>
  );
}

const ACCENTS = {
  rose: {
    border: 'border-rose-500/35',
    bg: 'bg-rose-500/10',
    text: 'text-rose-300',
    dot: 'bg-rose-400',
  },
  amber: {
    border: 'border-amber-500/35',
    bg: 'bg-amber-500/10',
    text: 'text-amber-300',
    dot: 'bg-amber-400',
  },
  emerald: {
    border: 'border-emerald-500/35',
    bg: 'bg-emerald-500/10',
    text: 'text-emerald-300',
    dot: 'bg-emerald-400',
  },
} as const;

type Accent = keyof typeof ACCENTS;

function RoomRow(props: {
  name: string;
  role: string;
  agent: string;
  doc: string;
  desc: string;
  accent: Accent;
}) {
  const a = ACCENTS[props.accent];
  return (
    <div className={`rounded-xl border ${a.border} ${a.bg} p-3.5`}>
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-sm font-semibold text-white">#{props.name}</span>
        <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${a.border} ${a.text}`}>
          🔒 {props.role}
        </span>
      </div>
      <p className="text-xs text-slate-300 mt-1.5">{props.desc}</p>
      <div className="mt-2 flex flex-wrap gap-1.5 text-[10px] font-mono">
        <span className="px-1.5 py-0.5 rounded bg-slate-950/70 border border-slate-800 text-slate-300 flex items-center gap-1">
          <span className={`w-1.5 h-1.5 rounded-full ${a.dot}`} />@{props.agent}
        </span>
        <span className="px-1.5 py-0.5 rounded bg-slate-950/70 border border-slate-800 text-slate-400 flex items-center gap-1">
          <FileText className="w-3 h-3" />
          {props.doc}
        </span>
      </div>
    </div>
  );
}

function LinkRow({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 pl-4 text-[11px] font-mono text-slate-500">
      <ArrowRight className="w-3.5 h-3.5 text-emerald-500/80" />
      <span>room link · {label}</span>
    </div>
  );
}

function Problem({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <div className="flex items-start gap-3">
      <div className="w-8 h-8 rounded-lg bg-slate-900 border border-slate-800 flex items-center justify-center shrink-0">
        {icon}
      </div>
      <div>
        <div className="font-medium text-white">{title}</div>
        <p className="text-slate-400 mt-1 leading-relaxed">{body}</p>
      </div>
    </div>
  );
}

function SectionHeading(props: {
  eyebrow: string;
  title: string;
  body: string;
  align?: 'left' | 'center';
}) {
  const center = props.align !== 'left';
  return (
    <div className={center ? 'max-w-3xl mx-auto text-center' : 'max-w-2xl'}>
      <div className="text-xs font-mono uppercase tracking-wider text-emerald-400">{props.eyebrow}</div>
      <h2 className="mt-3 text-3xl sm:text-4xl font-semibold tracking-tight text-white">{props.title}</h2>
      <p className="mt-4 text-slate-300 leading-relaxed">{props.body}</p>
    </div>
  );
}

function StageCard(props: {
  step: string;
  room: string;
  agent: string;
  role: string;
  doc: string;
  accent: Accent;
  points: string[];
}) {
  const a = ACCENTS[props.accent];
  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6 flex flex-col gap-4 hover:border-slate-700 transition">
      <div className="flex items-center justify-between">
        <span className={`font-mono text-xs ${a.text}`}>STEP {props.step}</span>
        <span className={`text-[10px] font-mono px-2 py-0.5 rounded border ${a.border} ${a.bg} ${a.text}`}>
          🔒 {props.role}
        </span>
      </div>
      <div>
        <div className="font-mono text-lg font-semibold text-white">{props.room}</div>
        <div className="text-xs font-mono text-slate-400 mt-0.5">
          {props.agent} · doc: {props.doc}
        </div>
      </div>
      <ul className="space-y-2 text-sm text-slate-300">
        {props.points.map((p) => (
          <li key={p} className="flex items-start gap-2">
            <CheckCircle2 className={`w-4 h-4 mt-0.5 shrink-0 ${a.text}`} />
            <span>{p}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Differentiator({ tag, title, body }: { tag: string; title: string; body: string }) {
  return (
    <div className="rounded-2xl border border-emerald-500/25 bg-gradient-to-br from-emerald-500/10 to-slate-900/60 p-6 hover:border-emerald-500/50 transition">
      <div className="text-[11px] font-mono uppercase tracking-wider text-emerald-300">{tag}</div>
      <div className="mt-2 text-lg font-semibold text-white">{title}</div>
      <p className="mt-3 text-sm text-slate-300 leading-relaxed">{body}</p>
    </div>
  );
}

function Primitive({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-5 hover:border-slate-700 transition">
      <div className="w-10 h-10 rounded-lg bg-slate-950 border border-slate-800 flex items-center justify-center">
        {icon}
      </div>
      <div className="mt-4 font-semibold text-white">{title}</div>
      <p className="mt-2 text-sm text-slate-400 leading-relaxed">{body}</p>
    </div>
  );
}

function DemoStep({ n, icon, title, body }: { n: number; icon: React.ReactNode; title: string; body: string }) {
  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-5 relative">
      <div className="absolute top-4 right-4 font-mono text-3xl font-semibold text-slate-800">
        {String(n).padStart(2, '0')}
      </div>
      <div className="w-10 h-10 rounded-lg bg-slate-950 border border-slate-800 flex items-center justify-center">
        {icon}
      </div>
      <div className="mt-4 font-semibold text-white">{title}</div>
      <p className="mt-2 text-sm text-slate-400 leading-relaxed">{body}</p>
    </div>
  );
}
