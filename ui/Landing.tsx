import React, { useEffect, useState } from 'react';
import {
  Activity,
  Archive,
  ArrowRight,
  Bot,
  Boxes,
  CheckCircle2,
  ChevronDown,
  ClipboardCheck,
  Code2,
  Cpu,
  Eye,
  FileText,
  Flame,
  Gauge,
  GitBranch,
  GitCommit,
  GitMerge,
  Github,
  HeartPulse,
  Layers,
  Link2,
  Lock,
  MessageSquare,
  Network,
  Play,
  Radio,
  Rocket,
  Scale,
  Server,
  ShieldAlert,
  ShieldCheck,
  Siren,
  Skull,
  Terminal,
  Upload,
  UserCheck,
  Workflow,
  Wrench,
  XCircle,
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
  patchMode?: string;
}

const REPO_URL = 'https://github.com/mrnetwork0001/Vigil';

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
          deployedVersion: snap?.checkoutTelemetry?.deployedVersion ?? '-',
          status: snap?.checkoutTelemetry?.status ?? 'healthy',
          errorRatePct: snap?.checkoutTelemetry?.errorRatePct ?? 0,
          patchMode: snap?.patchMode,
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

      {/* ───────────────────────────── Nav ───────────────────────────── */}
      <header className="relative z-20 sticky top-0 bg-slate-950/80 backdrop-blur border-b border-slate-800/60">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between gap-4">
          <a href="/" className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-emerald-500/15 border border-emerald-500/40 flex items-center justify-center">
              <ShieldCheck className="w-5 h-5 text-emerald-400" />
            </div>
            <div className="leading-tight">
              <div className="font-semibold tracking-tight text-white">VIGIL</div>
              <div className="text-[11px] font-mono text-slate-400">Incident-to-Hotfix War Room on Switch</div>
            </div>
          </a>

          <nav className="hidden lg:flex items-center gap-5 text-sm text-slate-300">
            <a href="#real" className="hover:text-white transition">What is real</a>
            <a href="#lifecycle" className="hover:text-white transition">Lifecycle</a>
            <a href="#differentiators" className="hover:text-white transition">Differentiators</a>
            <a href="#architecture" className="hover:text-white transition">Architecture</a>
            <a href="#safety" className="hover:text-white transition">Safety</a>
            <a href="#demo" className="hover:text-white transition">Demo</a>
            <a href="#quickstart" className="hover:text-white transition">Quickstart</a>
            <a href="#faq" className="hover:text-white transition">FAQ</a>
          </nav>

          <div className="flex items-center gap-2">
            <a
              href={REPO_URL}
              target="_blank"
              rel="noreferrer"
              className="hidden sm:flex px-3 py-2 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-700 text-slate-200 text-sm items-center gap-2 transition"
            >
              <Github className="w-4 h-4" />
              Repo
            </a>
            <button
              onClick={onLaunch}
              className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-semibold flex items-center gap-2 shadow-lg shadow-emerald-900/40 transition"
            >
              <Rocket className="w-4 h-4" />
              Launch App
            </button>
          </div>
        </div>
      </header>

      {/* ───────────────────────────── Hero ───────────────────────────── */}
      <section className="relative z-10 max-w-7xl mx-auto px-6 pt-14 pb-16 grid lg:grid-cols-12 gap-12 items-center">
        <div className="lg:col-span-6">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 text-emerald-300 text-xs font-mono mb-6">
            <Zap className="w-3.5 h-3.5" />
            Flip the Switch Hackathon · Track 01: Best Business Workflow
          </div>

          <h1 className="text-4xl sm:text-5xl lg:text-6xl font-semibold tracking-tight text-white leading-[1.05]">
            A real outage, a real fix, a real{' '}
            <span className="text-transparent bg-clip-text bg-gradient-to-r from-emerald-300 via-emerald-400 to-teal-300">
              human sign-off
            </span>
            . All inside Switch rooms.
          </h1>

          <p className="mt-6 text-lg text-slate-300 leading-relaxed max-w-xl">
            Vigil deploys a regression to a live checkout service, lets deterministic Switch agents and
            the coding agent you already use reproduce it, revert or patch it in git, run the real test
            suite, and then stops. A human approves the release in Mattermost, Discord, Telegram, or
            Slack. Every step is an operation on a Switch room: a lease, a document, a link, a message.
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
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" /> Switch v1 Group Template
            </span>
            <span className="flex items-center gap-1.5">
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" /> git-backed target service
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
                      {live.agentsOnline}/{live.agentsTotal} agents connected · {live.roomCount} rooms
                    </span>
                  </>
                ) : (
                  <>
                    <Radio className="w-3 h-3 text-slate-500 animate-pulse" />
                    <span className="text-slate-500">connecting to runtime…</span>
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
                desc="Receives the real 5xx webhook, reads the HEAD commit from git, claims the exclusive lease."
                accent="rose"
              />
              <LinkRow label="escalates reproduction & patch request" />
              <RoomRow
                name="vigil-hotfix"
                role="patch-author · red-team-verifier"
                agent="vigil-patcher"
                doc="patch-verification-report"
                desc="git revert or external diff, git apply, real node:test suite. Red stays here."
                accent="amber"
              />
              <LinkRow label="stages verified candidate for human sign-off" />
              <RoomRow
                name="vigil-releases"
                role="release-gatekeeper"
                agent="vigil-release-gate"
                doc="release-safety-policy · postmortem-inc-xxxx"
                desc="Rejects agent approvals. On a human approve: restart from candidate commit, 5 live canary probes."
                accent="emerald"
              />
            </div>

            <div className="px-5 py-3 border-t border-slate-800 bg-slate-950/60 flex flex-wrap items-center justify-between gap-2 text-[11px] font-mono">
              <span className="flex items-center gap-1.5 text-slate-400">
                <Activity className="w-3.5 h-3.5 text-emerald-400" />
                checkout-api {live ? live.deployedVersion : 'v2.13.2'}
              </span>
              <span className={live?.status === 'degraded' ? 'text-rose-300' : 'text-emerald-300'}>
                {live
                  ? live.status === 'degraded'
                    ? `DEGRADED · 5xx ${live.errorRatePct}%`
                    : 'HEALTHY'
                  : 'HEALTHY'}
              </span>
              <span className="text-slate-500">
                {live?.mode === 'live_switch_console_server'
                  ? 'Switch Console · live bridge'
                  : 'embedded Switch protocol server'}
                {live?.patchMode ? ` · patcher: ${live.patchMode}` : ''}
              </span>
            </div>
          </div>
        </div>
      </section>

      {/* ───────────────────────────── What is real ───────────────────────────── */}
      <section id="real" className="relative z-10 border-y border-slate-800/80 bg-slate-900/40">
        <div className="max-w-7xl mx-auto px-6 py-14">
          <SectionHeading
            eyebrow="No mocked data"
            title="What runs for real, and what is seeded."
            body="Judges read code. So here is the honest inventory. Everything in the left column is a real process, a real git operation, a real test run, or a real HTTP request. The right column is the only part we author ahead of time."
          />
          <div className="mt-10 grid lg:grid-cols-2 gap-6">
            <div className="rounded-2xl border border-emerald-500/30 bg-emerald-500/5 p-6">
              <div className="flex items-center gap-2 text-emerald-300 font-semibold">
                <CheckCircle2 className="w-5 h-5" /> Real
              </div>
              <ul className="mt-4 space-y-3 text-sm text-slate-300">
                <RealItem icon={<Server className="w-4 h-4 text-emerald-400" />} title="checkout-api is a real Node/TypeScript HTTP service">
                  Source lives under <code className="font-mono text-emerald-300">services/checkout-api</code> (cartPricing.ts, server.ts, a node:test suite). It runs as a child process on :4020 from a git-backed working copy that Vigil initialises at startup. Tag <code className="font-mono">v2.13.2</code> is last known good.
                </RealItem>
                <RealItem icon={<GitCommit className="w-4 h-4 text-emerald-400" />} title="Regressions are deployed with git">
                  Chaos injection applies a real patch with <code className="font-mono">git apply</code>, commits it under the offending author and message, bumps VERSION to v2.14.0, and restarts the process.
                </RealItem>
                <RealItem icon={<Gauge className="w-4 h-4 text-emerald-400" />} title="Telemetry is measured, not seeded">
                  A built-in traffic generator sends real mixed-currency checkouts. The service measures error rate and p99 from those requests, exposes <code className="font-mono">/metrics</code>, and POSTs a real alert webhook to Vigil on the first 5xx of a new version.
                </RealItem>
                <RealItem icon={<GitMerge className="w-4 h-4 text-emerald-400" />} title="Fixes are real commits verified by the real test suite">
                  Auto mode performs <code className="font-mono">git revert</code> of the regression commit. External mode applies a coding agent's diff with <code className="font-mono">git apply</code>. Either way the service's own tests run and a red run is never staged.
                </RealItem>
                <RealItem icon={<Activity className="w-4 h-4 text-emerald-400" />} title="Promotion, rollback, and canary are real">
                  On approval the service restarts from the candidate commit (promote) or resets to v2.13.2 (rollback), then five real HTTP probes hit <code className="font-mono">/api/checkout</code>.
                </RealItem>
                <RealItem icon={<Radio className="w-4 h-4 text-emerald-400" />} title="The Switch protocol client is real">
                  Genuine WebSocket connection, synchronous pong on every ping, generation fencing, gap recovery, final halt on <code className="font-mono">taken_over</code>, and HTTP operations with <code className="font-mono">X-Switch-Connection-Id</code>.
                </RealItem>
              </ul>
            </div>

            <div className="rounded-2xl border border-amber-500/30 bg-amber-500/5 p-6">
              <div className="flex items-center gap-2 text-amber-300 font-semibold">
                <Eye className="w-5 h-5" /> Seeded or chosen by us
              </div>
              <ul className="mt-4 space-y-3 text-sm text-slate-300">
                <RealItem icon={<Flame className="w-4 h-4 text-amber-400" />} title="The three regressions">
                  We wrote the buggy patches so the demo is repeatable: a JPY/KRW zero-decimal currency scale crash (500), stacked duplicate promo codes driving the charge negative (500), and an inventory semaphore leak on fraud decline causing a 503 cascade. They are real code changes, but we chose them.
                </RealItem>
                <RealItem icon={<Network className="w-4 h-4 text-amber-400" />} title="The Switch server in Mode A">
                  For zero-setup runs Vigil starts an embedded protocol server written to the published Switch agent protocol. Mode B connects the identical agents to a real Switch Console server and a real chat bridge. Nothing in the agents changes between modes.
                </RealItem>
                <RealItem icon={<Bot className="w-4 h-4 text-amber-400" />} title="The agents are deterministic">
                  No LLM anywhere in the mesh. Sentinel, patcher, and release gate are state machines over Switch operations. The only place an LLM can appear is the external coding agent you bind through Switch Console, and Vigil verifies its output with tests, not trust.
                </RealItem>
              </ul>
            </div>
          </div>
        </div>
      </section>

      {/* ───────────────────────────── Lifecycle timeline ───────────────────────────── */}
      <section id="lifecycle" className="relative z-10 border-y border-slate-800/80 bg-slate-900/30">
        <div className="max-w-7xl mx-auto px-6 py-16">
          <SectionHeading
            eyebrow="The workflow"
            title="One incident, nine steps, every one of them a Switch operation."
            body="Each step names the room it happens in, the agent that acts, the Switch operation it calls, and the artifact it leaves behind. Nothing is hidden in a terminal."
          />

          <ol className="mt-12 relative border-l border-slate-800 ml-3 space-y-8">
            <Step
              n={1}
              icon={<Siren className="w-4 h-4" />}
              accent="rose"
              title="Webhook"
              room="checkout-api → vigil runtime"
              agent="service"
              ops={['POST alert webhook']}
              artifact="first 5xx on v2.14.0 with the failing payload, status, error line, and HEAD sha"
              body="The traffic generator is sending real checkouts. The first one that fails on a new version makes the service POST an alert to Vigil. Vigil did not fabricate the alert; the service did."
            />
            <Step
              n={2}
              icon={<GitBranch className="w-4 h-4" />}
              accent="rose"
              title="Triage"
              room="#vigil-incidents"
              agent="@vigil-sentinel"
              ops={['assume_role incident-commander', 'create_room_document']}
              artifact="blast-radius-dossier"
              body="The sentinel reads the real HEAD commit from the service's git working copy, correlates it with the failing payload, claims the exclusive incident-commander lease so nobody else triages the same alert, and writes the dossier as a room document."
            />
            <Step
              n={3}
              icon={<Link2 className="w-4 h-4" />}
              accent="rose"
              title="Escalate"
              room="#vigil-incidents → #vigil-hotfix"
              agent="@vigil-sentinel"
              ops={['list_linked_rooms', 'create_room', 'link_rooms', 'send_targeted_message']}
              artifact="ESCALATE message with repro payload; ephemeral #hotfix-inc-xxxx workroom"
              body="The sentinel asks Switch where the work goes next instead of hardcoding a channel. It also instantiates the per-incident workroom from a template and links it from #vigil-hotfix."
            />
            <Step
              n={4}
              icon={<Wrench className="w-4 h-4" />}
              accent="amber"
              title="Patch"
              room="#vigil-hotfix"
              agent="@vigil-patcher (auto) or your coding agent (external)"
              ops={['assume_role patch-author', 'load_internal_documents', 'post_message']}
              artifact="a real commit: git revert of the regression, or an externally authored diff"
              body="Auto mode reverts the regression commit and bumps VERSION to v2.14.1-hotfix. External mode hands patch-author to the Claude Code, Codex, or Antigravity session bound through Switch Console; it posts its unified diff in a diff fence or via the stage-patch endpoint."
            />
            <Step
              n={5}
              icon={<ClipboardCheck className="w-4 h-4" />}
              accent="amber"
              title="Verify"
              room="#vigil-hotfix · #hotfix-inc-xxxx"
              agent="@vigil-patcher as red-team-verifier"
              ops={['assume_role red-team-verifier', 'create_room_document', 'release_role']}
              artifact="patch-verification-report with the diff and the real test output"
              body="The candidate is applied with git apply and the service's own node:test suite runs. Red output stays in the hotfix room with the failing tests listed. Only green reaches the release room."
            />
            <Step
              n={6}
              icon={<Scale className="w-4 h-4" />}
              accent="emerald"
              title="Gate"
              room="#vigil-releases"
              agent="@vigil-release-gate"
              ops={['assume_role release-gatekeeper', 'load_internal_documents release-safety-policy']}
              artifact="gate decision with a reason code"
              body="The gate re-reads the policy document, then waits. It rejects any @switch-agent-* sender, any wrong incident ID, any approver outside the policy's allowed list, any diff over the cap or touching a forbidden path."
            />
            <Step
              n={7}
              icon={<UserCheck className="w-4 h-4" />}
              accent="emerald"
              title="Human sign-off and canary"
              room="#vigil-releases (Mattermost, Discord, Telegram, or Slack)"
              agent="a human teammate, then @vigil-release-gate"
              ops={['message from @switch-user-*', 'restart from candidate commit', '5 HTTP canary probes']}
              artifact="service running v2.14.1-hotfix, or reset to v2.13.2 on rollback"
              body="A person types approve INC-xxxx promote or rollback. The gate restarts the service process from the approved commit and fires five real checkout probes before it calls the incident closed."
            />
            <Step
              n={8}
              icon={<FileText className="w-4 h-4" />}
              accent="emerald"
              title="Postmortem"
              room="#vigil-releases → #vigil-incidents"
              agent="@vigil-release-gate, then @vigil-sentinel"
              ops={['create_room_document postmortem-inc-xxxx', 'release_role', 'send_targeted_message']}
              artifact="postmortem-inc-xxxx; updated blast-radius-dossier; incident-commander lease released"
              body="The postmortem names the approver, the author of the fix, the root-cause commit, the canary results, and time to resolution. The gate follows the room link back and the sentinel closes out."
            />
            <Step
              n={9}
              icon={<Archive className="w-4 h-4" />}
              accent="sky"
              title="Archive"
              room="#hotfix-inc-xxxx"
              agent="@vigil-sentinel"
              ops={['archive_room']}
              artifact="archived workroom; durable artifacts remain in the three permanent rooms"
              body="The scratch room for the incident is archived. It keeps its log but accepts no new work. Rooms become part of the audit trail instead of static channels."
            />
          </ol>
        </div>
      </section>

      {/* ───────────────────────────── Differentiators ───────────────────────────── */}
      <section id="differentiators" className="relative z-10 max-w-7xl mx-auto px-6 py-16">
        <SectionHeading
          eyebrow="Why this entry is different"
          title="Four things we think nobody else will show."
          body="Each one leans on a Switch primitive that only matters once an agent and a team share a room."
        />
        <div className="mt-12 grid md:grid-cols-2 gap-6">
          <Differentiator
            icon={<Cpu className="w-5 h-5 text-indigo-300" />}
            tag="Your agent, verified"
            title="Claude Code writes the fix. Vigil runs the tests."
            body="Bind the coding agent you already use into #vigil-hotfix through Switch Console. Vigil's patcher steps back into the red-team-verifier seat, applies the agent's diff with git apply, and runs the service's real test suite. A diff that doesn't fix the bug fails and never reaches the release room."
            points={[
              'patch-author lease belongs to the external agent; red-team-verifier to vigil-patcher',
              'Diff arrives as a ```diff fence in chat or POST /api/incidents/{id}/stage-patch',
              'Verification is the real node:test run, not pattern matching on the diff',
            ]}
          />
          <Differentiator
            icon={<Scale className="w-5 h-5 text-amber-300" />}
            tag="Governance in the room"
            title="Release policy is a Switch room document."
            body="The gate re-reads release-safety-policy on every approval. A human types set max diff 1 or set approvers sam and the next decision follows the new rules. An agent that tries the same command is blocked. Governance moves out of code and into the room everyone can see."
            points={[
              'max_changed_lines, forbidden_paths, require_green_matrix, allowed_approvers, min_canary_probes',
              'Written back with update_room_document, so the change is itself an audited artifact',
              'REJECTED_UNAUTHORIZED_APPROVER and REJECTED_DIFF_POLICY_VIOLATION cite the policy that failed',
            ]}
          />
          <Differentiator
            icon={<HeartPulse className="w-5 h-5 text-rose-300" />}
            tag="Lease failover"
            title="Crash the incident commander. Nothing is lost."
            body="Crash Sentinel wedges the live client: the socket stays open but pings go unanswered. Failover Sentinel reopens the same connection_id from the last acknowledged cursor. The server evicts the wedged socket with taken_over, the new generation resumes without a gap, and the exclusive incident-commander lease is re-asserted mid-incident."
            points={[
              'Exercises generation fencing, cursor resume, and the final taken_over eviction',
              'The incident closes through the standby, so the lease and the room link survive the crash',
              'Visible live in the WS Protocol inspector and the failover log',
            ]}
          />
          <Differentiator
            icon={<Boxes className="w-5 h-5 text-sky-300" />}
            tag="Rooms with a lifecycle"
            title="One ephemeral workroom per incident."
            body="Each incident gets #hotfix-inc-xxxx, created from vigil-hotfix-workroom.template.yaml with its own patch-author and release-gatekeeper roles and the stack trace in its instructions. It is linked from #vigil-hotfix, receives the verifier's red/blue verdict, and is archived at closure."
            points={[
              'create_room, link_rooms, archive_room used as lifecycle operations, not setup',
              'Archived rooms refuse new messages and drop their leases',
              'Durable artifacts stay in the permanent rooms; scratch context goes away',
            ]}
          />
        </div>
      </section>

      {/* ───────────────────────────── Architecture ───────────────────────────── */}
      <section id="architecture" className="relative z-10 border-y border-slate-800/80 bg-slate-900/30">
        <div className="max-w-7xl mx-auto px-6 py-16">
          <SectionHeading
            eyebrow="Architecture"
            title="Four processes, one protocol."
            body="The target service, the Vigil runtime, the Switch server, and the chat bridges are separate processes. The agents only ever speak the Switch agent protocol; swapping the embedded server for Switch Console changes a URL."
          />

          <div className="mt-12 grid lg:grid-cols-12 gap-8 items-start">
            <div className="lg:col-span-12 rounded-2xl border border-slate-800 bg-slate-950 shadow-2xl overflow-hidden">
              <div className="px-4 py-2.5 border-b border-slate-800 flex items-center gap-2 text-xs font-mono text-slate-400">
                <Layers className="w-3.5 h-3.5 text-emerald-400" />
                topology
              </div>
              <pre className="p-5 font-mono text-[12px] leading-relaxed text-slate-200 overflow-x-auto">
{`┌──────────────────────────────┐      alert webhook (first 5xx)      ┌────────────────────────────────────┐
│  checkout-api  :4020         │ ──────────────────────────────────▶ │  Vigil runtime  :4010              │
│  services/checkout-api       │                                     │  • vigil-sentinel     (WS client)  │
│  node child process          │ ◀── git apply / revert / restart ── │  • vigil-patcher      (WS client)  │
│  git working copy            │ ◀── 5 canary probes /api/checkout ─ │  • vigil-release-gate (WS client)  │
│  tags: v2.13.2 (LKG)         │ ◀── synthetic traffic generator ─── │  • Observatory UI + /api           │
│  /health  /metrics           │                                     │  • traffic generator               │
└──────────────────────────────┘                                     └──────────────┬─────────────────────┘
                                                                                    │ WebSocket /agents/{id}/connection/ws
                                                                                    │ HTTP     /agents/{id}/ops/{operation}
                                                                                    ▼
                                           ┌──────────────────────────────────────────────────────────────┐
                                           │  Switch server                                               │
                                           │  Mode A: embedded protocol server (zero setup)               │
                                           │  Mode B: Switch Console local server (Docker)                │
                                           │  rooms · roles · documents · links · agents                  │
                                           └──────────────┬───────────────────────────────────────────────┘
                                                          │ bridge
                                                          ▼
                                           ┌──────────────────────────────────────────────────────────────┐
                                           │  Mattermost · Discord · Telegram · Slack                     │
                                           │  #vigil-incidents  #vigil-hotfix  #vigil-releases            │
                                           │  #hotfix-inc-xxxx (ephemeral)                                │
                                           │  humans type:  approve INC-2041 promote | rollback           │
                                           └──────────────────────────────────────────────────────────────┘`}
              </pre>
            </div>

          </div>

          <div className="mt-12">
            <h3 className="text-lg font-semibold text-white flex items-center gap-2">
              <Workflow className="w-5 h-5 text-emerald-400" />
              Switch operations Vigil calls, and where
            </h3>
            <div className="mt-4 overflow-x-auto rounded-2xl border border-slate-800">
              <table className="w-full text-sm">
                <thead className="bg-slate-900/80 text-slate-400 text-xs uppercase tracking-wider">
                  <tr>
                    <th className="text-left px-4 py-3 font-medium">Operation</th>
                    <th className="text-left px-4 py-3 font-medium">Caller</th>
                    <th className="text-left px-4 py-3 font-medium">Where Vigil uses it</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800 text-slate-300">
                  <OpRow op="list_rooms" who="all three" use="Bootstrap: resolve the room IDs provisioned by the template instead of hardcoding them." />
                  <OpRow op="connect_to_room" who="any" use="Claim a room on a single-scope connection and load its context, roles, and documents." />
                  <OpRow op="read_context" who="all three" use="Re-read recent history after a gap frame, and on failover so the standby knows where the incident stands." />
                  <OpRow op="post_message" who="all three" use="Triage summaries, verifier verdicts, gate decisions, policy confirmations, closure notices." />
                  <OpRow op="send_targeted_message" who="sentinel, patcher, gate" use="Room-to-room handoffs: ESCALATE to the patcher, HANDOFF to the gate, RESOLVED back to the sentinel." />
                  <OpRow op="assume_role" who="all three" use="Exclusive leases: incident-commander, patch-author, red-team-verifier, release-gatekeeper. 409 if someone else holds it." />
                  <OpRow op="release_role" who="all three" use="Hand back each lease at the end of its stage, so the next incident starts clean." />
                  <OpRow op="create_room_document" who="sentinel, patcher, gate" use="blast-radius-dossier, patch-verification-report, postmortem-inc-xxxx." />
                  <OpRow op="update_room_document" who="sentinel, gate" use="Close out the dossier; write policy changes back to release-safety-policy." />
                  <OpRow op="load_internal_documents" who="patcher, gate" use="Read the reproduction playbook before patching; read release-safety-policy on every approval." />
                  <OpRow op="list_linked_rooms" who="all three" use="Discover the next room in the pipeline at runtime (incidents → hotfix → releases → incidents)." />
                  <OpRow op="create_room" who="sentinel" use="Instantiate the per-incident #hotfix-inc-xxxx workroom from the hotfix workroom template." />
                  <OpRow op="link_rooms" who="sentinel" use="Attach the workroom to #vigil-hotfix with a labelled directed link." />
                  <OpRow op="archive_room" who="sentinel" use="Retire the workroom at closure; it keeps its log and refuses new work." />
                  <OpRow op="update_agent_detail" who="all three" use="Widen addressing at bootstrap; a freshly registered agent otherwise answers only its owner." />
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </section>

      {/* ───────────────────────────── Safety model ───────────────────────────── */}
      <section id="safety" className="relative z-10 max-w-7xl mx-auto px-6 py-16">
        <SectionHeading
          eyebrow="Safety model"
          title="The release gate is deterministic. It has no opinion."
          body="Every production change passes a fixed set of invariants. Most of them are parameters in a Switch room document that humans can read and edit from chat. None of them can be argued with."
        />
        <div className="mt-12 grid lg:grid-cols-2 gap-8">
          <div className="space-y-3">
            <Invariant n={1} title="Human-only sign-off" body="The sender's participant id must be a @switch-user-*. Agent identities, disguised display names, and handles that collide with a registered agent are rejected with REJECTED_AGENT_SENDER." />
            <Invariant n={2} title="Incident binding" body="The approval must cite the active incident id. A stale or mistyped id is REJECTED_INCIDENT_MISMATCH." />
            <Invariant n={3} title="Allowed approvers" body="allowed_approvers in the policy document. any-human by default; set approvers sam restricts it, and everyone else gets REJECTED_UNAUTHORIZED_APPROVER." />
            <Invariant n={4} title="Green test matrix" body="promote requires a confirmed reproduction and a green run of the service's real tests. rollback to v2.13.2 is always available to an authorized human." />
            <Invariant n={5} title="Diff cap and forbidden paths" body="max_changed_lines and forbidden_paths from the policy document. Touching .env, secrets, auth keys, or drop migrations is REJECTED_DIFF_POLICY_VIOLATION regardless of tests." />
            <Invariant n={6} title="Canary probes" body="After the process restarts, five real checkout probes across USD, EUR, JPY, KRW, and a promo cart must return 200 before the incident is closed." />
          </div>
          <div className="rounded-2xl border border-rose-500/30 bg-rose-500/5 p-6">
            <div className="flex items-center gap-2 text-rose-300 font-semibold">
              <XCircle className="w-5 h-5" /> Explicitly refused
            </div>
            <ul className="mt-4 space-y-3 text-sm text-slate-300">
              <Refused>An agent approving, promoting, or rolling back anything, including the external coding agent.</Refused>
              <Refused>An agent editing release-safety-policy. Policy commands from agent senders are blocked and logged.</Refused>
              <Refused>Staging a candidate whose test run is red, in either patch mode.</Refused>
              <Refused>Promoting a diff that exceeds the cap or touches a forbidden path, even if tests pass.</Refused>
              <Refused>Reconnecting after taken_over. The evicted client halts for good; only the standby continues.</Refused>
              <Refused>Posting into an archived workroom.</Refused>
            </ul>
            <p className="mt-5 text-xs text-slate-400 leading-relaxed">
              Every decision, accepted or refused, is appended to the incident's gate audit log with its reason code and shown in the Observatory and in chat.
            </p>
          </div>
        </div>
      </section>

      {/* ───────────────────────────── Demo ───────────────────────────── */}
      <section id="demo" className="relative z-10 border-y border-slate-800/80 bg-slate-900/30">
        <div className="max-w-7xl mx-auto px-6 py-16">
          <SectionHeading
            eyebrow="Try it"
            title="The full incident in four clicks. Then break it on purpose."
            body="The app ships with the checkout service, the traffic generator, and the embedded Switch protocol server. No external setup for the basic demo."
          />

          <div className="mt-12 grid md:grid-cols-2 lg:grid-cols-4 gap-5">
            <DemoStep n={1} icon={<Flame className="w-5 h-5 text-rose-400" />} title="Deploy a regression" body="Pick JPY zero-decimal 500, stacked promo negative 500, or inventory lock leak 503. The patch is applied in git, VERSION becomes v2.14.0, and the service restarts." />
            <DemoStep n={2} icon={<Bot className="w-5 h-5 text-indigo-400" />} title="Watch the relay" body="The first real 5xx fires the webhook. Sentinel, patcher, and release gate work across the three rooms over live WebSocket frames you can inspect." />
            <DemoStep n={3} icon={<ShieldAlert className="w-5 h-5 text-amber-400" />} title="Test the rogue agent block" body="An agent identity tries approve INC-2041 promote. The gate rejects it and the service stays on v2.14.0." />
            <DemoStep n={4} icon={<UserCheck className="w-5 h-5 text-emerald-400" />} title="Approve as Priya" body="Type approve INC-2041 promote. The service restarts on v2.14.1-hotfix, five canary probes pass, the postmortem is written, the workroom is archived." />
          </div>

          <h3 className="mt-14 text-lg font-semibold text-white">Three advanced demos</h3>
          <div className="mt-5 grid md:grid-cols-3 gap-5">
            <AdvancedDemo
              icon={<Upload className="w-5 h-5 text-indigo-300" />}
              title="External patch intake"
              steps={[
                'Flip patcher to your coding agent in the chaos strip and deploy a regression.',
                'vigil-patcher arms itself as red-team-verifier and waits for a diff.',
                'Use Load bad diff and submit: git apply succeeds, the tests fail, the candidate is rejected.',
                'Use Load reference fix or let Claude Code post its diff: tests pass, handoff to #vigil-releases.',
              ]}
            />
            <AdvancedDemo
              icon={<Scale className="w-5 h-5 text-amber-300" />}
              title="Tighten policy from chat"
              steps={[
                'With a candidate at the gate, send @vigil-release-gate set max diff 1 in #vigil-releases.',
                'Approve: the gate rejects with REJECTED_DIFF_POLICY_VIOLATION and cites the room document.',
                'Try set approvers sam, then approve as Priya: REJECTED_UNAUTHORIZED_APPROVER.',
                'Approve as Sam. Promotion, canary, postmortem.',
              ]}
            />
            <AdvancedDemo
              icon={<Skull className="w-5 h-5 text-rose-300" />}
              title="Commander failover"
              steps={[
                'Mid-incident, click Crash Sentinel. The socket stays open; pings go unanswered.',
                'Click Failover Sentinel. The standby reopens the same connection_id from the last cursor.',
                'Watch the WS Protocol tab: evicted: taken_over on the old generation, a new generation online.',
                'The lease is re-asserted and the incident closes through the standby.',
              ]}
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
        </div>
      </section>

      {/* ───────────────────────────── Quickstart ───────────────────────────── */}
      <section id="quickstart" className="relative z-10 max-w-7xl mx-auto px-6 py-16">
        <SectionHeading
          eyebrow="Quickstart"
          title="Two ways to run it."
          body="Mode A reproduces everything on one laptop with no accounts. Mode B connects the same agents to a real Switch Console server and your team chat."
        />

        <div className="mt-12 grid lg:grid-cols-2 gap-8 items-start">
          <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6">
            <div className="flex items-center gap-2 text-emerald-300 font-semibold">
              <Terminal className="w-5 h-5" /> Mode A: embedded protocol server
            </div>
            <p className="mt-2 text-sm text-slate-300">
              Clone, test, build, start. Vigil initialises the checkout service's git working copy, starts the
              embedded Switch protocol server, provisions the template, connects the three agents, and opens the Observatory.
            </p>
            <div className="mt-4 rounded-xl border border-slate-800 bg-slate-950 overflow-hidden">
              <div className="px-4 py-2 border-b border-slate-800 text-xs font-mono text-slate-400">terminal</div>
              <pre className="p-4 font-mono text-[12.5px] leading-relaxed text-slate-200 overflow-x-auto">
{`$ git clone ${REPO_URL}.git && cd Vigil
$ npm install
$ npm test          # protocol, chaos, gate, policy, failover suites
$ npm run build
$ npm start

⚡ Vigil :: Autonomous Incident-to-Hotfix War Room on Switch
• Observatory & API   : http://localhost:4010
• Checkout API Target : http://localhost:4020/health
• Switch Bridge Mode  : EMBEDDED
• Linked Switch Rooms : #vigil-incidents -> #vigil-hotfix -> #vigil-releases`}
              </pre>
            </div>
            <p className="mt-3 text-xs text-slate-400">
              Open http://localhost:4010 for this page and click Launch App for the war room at /app.
            </p>
          </div>

          <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6">
            <div className="flex items-center gap-2 text-indigo-300 font-semibold">
              <Network className="w-5 h-5" /> Mode B: Switch Console and your team chat
            </div>
            <ol className="mt-4 space-y-3 text-sm text-slate-300">
              <QuickStep n={1} title="Install Switch Console">
                Run <code className="font-mono text-indigo-300">scripts/install-switch-console.sh</code>, open Switch Console, choose On this computer, and Start. It launches the Switch server and bundled Mattermost in Docker. Optionally connect Discord or Telegram.
              </QuickStep>
              <QuickStep n={2} title="Create a registration key">
                In the Switch Gateway open API Keys and create a key of type registration. The account that creates it owns the agents.
              </QuickStep>
              <QuickStep n={3} title="Onboard the three agents">
                <code className="font-mono text-indigo-300">SWITCH_SERVER_URL=… SWITCH_REGISTRATION_KEY=… npm run onboard:switch</code> registers vigil-sentinel, vigil-patcher, and vigil-release-gate with POST /agents, widens their addressing, and writes credentials to .env.
              </QuickStep>
              <QuickStep n={4} title="Import the group template">
                Switch Console, Templates, Import template, select templates/vigil-war-room.template.yaml, pick your bridge, and choose Existing agent on the three cards. Optionally bind your Claude Code session into #vigil-hotfix and set SWITCH_CONSOLE_CODER_HANDLE.
              </QuickStep>
              <QuickStep n={5} title="Run Vigil against the live server">
                <code className="font-mono text-indigo-300">npm run dev</code>. Deploy a regression from the Observatory or <code className="font-mono text-indigo-300">npm run inject:fault jpy_zero_decimal_500</code>, then approve the release from Mattermost.
              </QuickStep>
            </ol>
          </div>
        </div>
      </section>

      {/* ───────────────────────────── FAQ ───────────────────────────── */}
      <section id="faq" className="relative z-10 border-t border-slate-800/80 bg-slate-900/30">
        <div className="max-w-4xl mx-auto px-6 py-16">
          <SectionHeading eyebrow="FAQ" title="Four questions worth answering." body="Short answers. The code is the long answer." />
          <div className="mt-10 space-y-3">
            <Faq q="Is any of this an LLM?">
              No. The sentinel, patcher, and release gate are deterministic state machines over Switch operations. The only place a model can appear is the external coding agent you bind through Switch Console, and Vigil treats its output as untrusted: the diff is applied with git apply and judged by the service's own test suite.
            </Faq>
            <Faq q="What happens if the external diff doesn't fix the bug?">
              git apply runs, the tests run, and the result is red. The verifier posts the failing tests in #vigil-hotfix, writes patch-verification-report with the output, and holds. Nothing is staged and the release gate never hears about it. Submit a corrected diff and it runs again.
            </Faq>
            <Faq q="What is simulated?">
              Two things. The three regressions are patches we authored so the demo is repeatable; they are still real code changes applied in git and deployed by restarting the real process. And in Mode A the Switch server is an embedded protocol server for zero-setup runs. Mode B replaces it with a real Switch Console server without changing the agents. Telemetry, tests, commits, restarts, probes, and every room operation are real in both modes.
            </Faq>
            <Faq q="Would this stop working without Switch?">
              Yes. Command is an exclusive role lease. The audit trail is room documents with enforced authorship. Routing is directed room links. The approval check is the participant id Switch attaches to a bridged chat message. Policy is a room document the gate re-reads. Remove Switch and there is no room for any of that to live in.
            </Faq>
          </div>
        </div>
      </section>

      {/* ───────────────────────────── Footer ───────────────────────────── */}
      <footer className="relative z-10 border-t border-slate-800/80">
        <div className="max-w-7xl mx-auto px-6 py-10 grid md:grid-cols-3 gap-8 text-sm">
          <div>
            <div className="flex items-center gap-2 text-white font-semibold">
              <ShieldCheck className="w-5 h-5 text-emerald-400" /> Vigil
            </div>
            <p className="mt-2 text-slate-400 leading-relaxed">
              Autonomous Incident-to-Hotfix War Room on Switch. Built for the Flip the Switch Hackathon by WeMakeDevs and Switch AI, Track 01: Best Business Workflow.
            </p>
          </div>
          <div className="text-slate-400 space-y-2">
            <div className="text-white font-medium">Links</div>
            <a href={REPO_URL} target="_blank" rel="noreferrer" className="flex items-center gap-2 hover:text-white transition">
              <Github className="w-4 h-4" /> github.com/mrnetwork0001/Vigil
            </a>
            <a href="#architecture" className="flex items-center gap-2 hover:text-white transition">
              <Code2 className="w-4 h-4" /> Switch operations table
            </a>
            <a href="#quickstart" className="flex items-center gap-2 hover:text-white transition">
              <Terminal className="w-4 h-4" /> Quickstart
            </a>
          </div>
          <div className="flex flex-col items-start md:items-end gap-3">
            <button
              onClick={onLaunch}
              className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-semibold flex items-center gap-2 transition"
            >
              <Rocket className="w-4 h-4" />
              Launch App
            </button>
            <span className="text-xs font-mono text-slate-500">MIT License</span>
          </div>
        </div>
      </footer>
    </div>
  );
}

/* ───────────────────────────── Helpers ───────────────────────────── */

const ACCENTS = {
  rose: { border: 'border-rose-500/35', bg: 'bg-rose-500/10', text: 'text-rose-300', dot: 'bg-rose-400' },
  amber: { border: 'border-amber-500/35', bg: 'bg-amber-500/10', text: 'text-amber-300', dot: 'bg-amber-400' },
  emerald: { border: 'border-emerald-500/35', bg: 'bg-emerald-500/10', text: 'text-emerald-300', dot: 'bg-emerald-400' },
  sky: { border: 'border-sky-500/35', bg: 'bg-sky-500/10', text: 'text-sky-300', dot: 'bg-sky-400' },
} as const;

type Accent = keyof typeof ACCENTS;

function RoomRow(props: { name: string; role: string; agent: string; doc: string; desc: string; accent: Accent }) {
  const a = ACCENTS[props.accent];
  return (
    <div className={`rounded-xl border ${a.border} ${a.bg} p-3.5`}>
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-sm font-semibold text-white">#{props.name}</span>
        <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${a.border} ${a.text}`}>🔒 {props.role}</span>
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

function RealItem({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-3">
      <div className="w-7 h-7 rounded-md bg-slate-950 border border-slate-800 flex items-center justify-center shrink-0 mt-0.5">{icon}</div>
      <div>
        <div className="font-medium text-white">{title}</div>
        <p className="text-slate-400 mt-0.5 leading-relaxed">{children}</p>
      </div>
    </li>
  );
}

function SectionHeading(props: { eyebrow: string; title: string; body: string; align?: 'left' | 'center' }) {
  const center = props.align !== 'left';
  return (
    <div className={center ? 'max-w-3xl mx-auto text-center' : 'max-w-2xl'}>
      <div className="text-xs font-mono uppercase tracking-wider text-emerald-400">{props.eyebrow}</div>
      <h2 className="mt-3 text-3xl sm:text-4xl font-semibold tracking-tight text-white">{props.title}</h2>
      <p className="mt-4 text-slate-300 leading-relaxed">{props.body}</p>
    </div>
  );
}

function Step(props: {
  n: number;
  icon: React.ReactNode;
  accent: Accent;
  title: string;
  room: string;
  agent: string;
  ops: string[];
  artifact: string;
  body: string;
}) {
  const a = ACCENTS[props.accent];
  return (
    <li className="relative pl-10">
      <span className={`absolute -left-[13px] top-1 w-6 h-6 rounded-full border ${a.border} ${a.bg} ${a.text} flex items-center justify-center`}>
        {props.icon}
      </span>
      <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-5">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`font-mono text-xs ${a.text}`}>STEP {String(props.n).padStart(2, '0')}</span>
          <span className="text-lg font-semibold text-white">{props.title}</span>
        </div>
        <p className="mt-2 text-sm text-slate-300 leading-relaxed">{props.body}</p>
        <dl className="mt-4 grid sm:grid-cols-2 gap-3 text-xs">
          <Meta label="Room" value={props.room} />
          <Meta label="Agent" value={props.agent} />
          <div className="sm:col-span-2">
            <dt className="font-mono uppercase tracking-wider text-slate-500 text-[10px]">Switch operations</dt>
            <dd className="mt-1 flex flex-wrap gap-1.5">
              {props.ops.map((op) => (
                <span key={op} className="px-1.5 py-0.5 rounded bg-slate-950 border border-slate-800 font-mono text-slate-200">
                  {op}
                </span>
              ))}
            </dd>
          </div>
          <Meta label="Artifact" value={props.artifact} wide />
        </dl>
      </div>
    </li>
  );
}

function Meta({ label, value, wide }: { label: string; value: string; wide?: boolean }) {
  return (
    <div className={wide ? 'sm:col-span-2' : ''}>
      <dt className="font-mono uppercase tracking-wider text-slate-500 text-[10px]">{label}</dt>
      <dd className="mt-1 text-slate-200 font-mono">{value}</dd>
    </div>
  );
}

function Differentiator(props: { icon: React.ReactNode; tag: string; title: string; body: string; points: string[] }) {
  return (
    <div className="rounded-2xl border border-emerald-500/25 bg-gradient-to-br from-emerald-500/10 to-slate-900/60 p-6 hover:border-emerald-500/50 transition flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div className="w-10 h-10 rounded-lg bg-slate-950 border border-slate-800 flex items-center justify-center">{props.icon}</div>
        <span className="text-[11px] font-mono uppercase tracking-wider text-emerald-300">{props.tag}</span>
      </div>
      <div className="text-xl font-semibold text-white">{props.title}</div>
      <p className="text-sm text-slate-300 leading-relaxed">{props.body}</p>
      <ul className="space-y-2 text-sm text-slate-300">
        {props.points.map((p) => (
          <li key={p} className="flex items-start gap-2">
            <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0 text-emerald-400" />
            <span>{p}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function OpRow({ op, who, use }: { op: string; who: string; use: string }) {
  return (
    <tr className="hover:bg-slate-900/50">
      <td className="px-4 py-3 font-mono text-emerald-300 whitespace-nowrap">{op}</td>
      <td className="px-4 py-3 text-slate-400 whitespace-nowrap">{who}</td>
      <td className="px-4 py-3">{use}</td>
    </tr>
  );
}

function Invariant({ n, title, body }: { n: number; title: string; body: string }) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4 flex items-start gap-3">
      <span className="font-mono text-xs text-emerald-300 mt-0.5">#{n}</span>
      <div>
        <div className="font-medium text-white">{title}</div>
        <p className="mt-1 text-sm text-slate-400 leading-relaxed">{body}</p>
      </div>
    </div>
  );
}

function Refused({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2">
      <XCircle className="w-4 h-4 mt-0.5 shrink-0 text-rose-400" />
      <span>{children}</span>
    </li>
  );
}

function DemoStep({ n, icon, title, body }: { n: number; icon: React.ReactNode; title: string; body: string }) {
  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-5 relative">
      <div className="absolute top-4 right-4 font-mono text-3xl font-semibold text-slate-800">{String(n).padStart(2, '0')}</div>
      <div className="w-10 h-10 rounded-lg bg-slate-950 border border-slate-800 flex items-center justify-center">{icon}</div>
      <div className="mt-4 font-semibold text-white">{title}</div>
      <p className="mt-2 text-sm text-slate-400 leading-relaxed">{body}</p>
    </div>
  );
}

function AdvancedDemo({ icon, title, steps }: { icon: React.ReactNode; title: string; steps: string[] }) {
  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-5">
      <div className="flex items-center gap-2 font-semibold text-white">
        <span className="w-9 h-9 rounded-lg bg-slate-950 border border-slate-800 flex items-center justify-center">{icon}</span>
        {title}
      </div>
      <ol className="mt-4 space-y-2 text-sm text-slate-300">
        {steps.map((s, i) => (
          <li key={s} className="flex items-start gap-2">
            <span className="font-mono text-[11px] text-slate-500 mt-0.5">{i + 1}.</span>
            <span>{s}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function QuickStep({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-3">
      <span className="w-6 h-6 rounded-full bg-indigo-500/15 border border-indigo-500/40 text-indigo-200 font-mono text-xs flex items-center justify-center shrink-0 mt-0.5">
        {n}
      </span>
      <div>
        <div className="font-medium text-white">{title}</div>
        <p className="mt-0.5 text-slate-400 leading-relaxed">{children}</p>
      </div>
    </li>
  );
}

function Faq({ q, children }: { q: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/60">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between gap-4 px-5 py-4 text-left"
        aria-expanded={open}
      >
        <span className="font-medium text-white">{q}</span>
        <ChevronDown className={`w-4 h-4 text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && <div className="px-5 pb-5 text-sm text-slate-300 leading-relaxed">{children}</div>}
    </div>
  );
}
