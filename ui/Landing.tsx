import React, { useEffect, useRef, useState } from 'react';
import { ArrowRight, ArrowUpRight, Plus, X } from 'lucide-react';
import './landing.css';
import { VigilLogo } from './VigilMark';

const REPO_URL = 'https://github.com/NetLayerLabs/Vigil';

const SECTIONS = [
  { id: 'proof', label: 'Proof' },
  { id: 'how', label: 'How it works' },
  { id: 'agent', label: 'Your agent' },
  { id: 'safety', label: 'Safety' },
  { id: 'run', label: 'Run it' },
  { id: 'faq', label: 'FAQ' },
] as const;

// ---------------------------------------------------------------------------------------------
// Live data from the running Vigil instance (same origin). Everything shown is read, not invented.
// ---------------------------------------------------------------------------------------------
interface LiveSnapshot {
  mode: string;
  patchMode?: 'auto' | 'external';
  checkoutTelemetry: {
    deployedVersion: string;
    status: 'healthy' | 'degraded';
    errorRatePct: number;
    /** False when the target has no metrics endpoint. */
    metricsMeasured?: boolean;
    p99LatencyMs: number;
    pid?: number;
    windowRequests?: number;
  };
  checkoutRepo?: { workDir: string; log: Array<{ sha: string; author: string; message: string; at: number }> };
  switchState: { agents: Array<{ name: string; online: boolean }>; rooms: Array<{ name: string }> };
  releasePolicy?: {
    maxChangedLines: number;
    forbiddenPaths: string[];
    requireGreenMatrix: boolean;
    allowedApprovers: string[];
    minCanaryProbes: number;
  };
  activeIncident: { incidentId: string; stage: string } | null;
}

function useLive(intervalMs = 3000) {
  const [snap, setSnap] = useState<LiveSnapshot | null>(null);
  const [offline, setOffline] = useState(false);
  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch('/api/state')
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .then((d: LiveSnapshot) => {
          if (!alive) return;
          setSnap(d);
          setOffline(false);
        })
        .catch(() => alive && setOffline(true));
    load();
    const t = setInterval(load, intervalMs);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [intervalMs]);
  return { snap, offline };
}

/** Adds `is-in` to every `[data-reveal]` element as it scrolls into view. */
function useReveal(root: React.RefObject<HTMLElement>) {
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const targets = Array.from(el.querySelectorAll<HTMLElement>('[data-reveal]'));
    if (!('IntersectionObserver' in window)) {
      targets.forEach((t) => t.classList.add('is-in'));
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            e.target.classList.add('is-in');
            io.unobserve(e.target);
          }
        }
      },
      { rootMargin: '0px 0px -8% 0px', threshold: 0.12 },
    );
    targets.forEach((t) => io.observe(t));
    return () => io.disconnect();
  }, [root]);
}

const fmtMs = (n: number | undefined) => (typeof n === 'number' ? `${n < 10 ? n.toFixed(1) : Math.round(n)}ms` : '–');

export function Landing({ onLaunch }: { onLaunch: () => void }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const heroRef = useRef<HTMLElement>(null);
  const [stickyShown, setStickyShown] = useState(false);
  const [active, setActive] = useState<string>('');
  const [menuOpen, setMenuOpen] = useState(false);
  const { snap, offline } = useLive();

  useReveal(rootRef);

  // Mobile drawer: Esc closes it, and the page behind it does not scroll while it is open.
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMenuOpen(false);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [menuOpen]);

  // Sticky header once the hero has scrolled away.
  useEffect(() => {
    const hero = heroRef.current;
    if (!hero) return;
    const io = new IntersectionObserver(([e]) => setStickyShown(!e.isIntersecting), { threshold: 0.04 });
    io.observe(hero);
    return () => io.disconnect();
  }, []);

  // Scroll-spy for the sticky links.
  useEffect(() => {
    const els = SECTIONS.map((s) => document.getElementById(s.id)).filter(Boolean) as HTMLElement[];
    const io = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio);
        if (visible[0]) setActive(visible[0].target.id);
      },
      { rootMargin: '-40% 0px -50% 0px', threshold: [0, 0.25, 0.5] },
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);

  const t = snap?.checkoutTelemetry;
  const agentsOnline = snap?.switchState.agents.filter((a) => a.online).length ?? 0;
  const policy = snap?.releasePolicy;

  return (
    <div className="vl" ref={rootRef}>
      {/* ───────────────────────── Sticky header ───────────────────────── */}
      <header className={`vl-sticky ${stickyShown ? 'is-shown' : ''}`} aria-hidden={!stickyShown}>
        <a href="#top" className="vl-logo" aria-label="Vigil, back to top">
          <VigilLogo />
        </a>
        <nav className="vl-sticky-links" aria-label="Sections">
          {SECTIONS.map((s) => (
            <a key={s.id} href={`#${s.id}`} className={`vl-sticky-link ${active === s.id ? 'is-active' : ''}`}>
              {s.label}
            </a>
          ))}
        </nav>
        <button
          type="button"
          className={`vl-burger vl-burger--sticky ${menuOpen ? 'is-open' : ''}`}
          aria-label={menuOpen ? 'Close menu' : 'Open menu'}
          aria-expanded={menuOpen}
          aria-controls="vl-drawer"
          tabIndex={stickyShown ? 0 : -1}
          onClick={() => setMenuOpen((v) => !v)}
        >
          <span />
          <span />
          <span />
        </button>
      </header>

      {/* ───────────────────────── Mobile drawer ───────────────────────── */}
      <button
        type="button"
        className={`vl-backdrop ${menuOpen ? 'is-open' : ''}`}
        aria-label="Close menu"
        tabIndex={menuOpen ? 0 : -1}
        onClick={() => setMenuOpen(false)}
      />
      <nav id="vl-drawer" className={`vl-drawer ${menuOpen ? 'is-open' : ''}`} aria-label="Menu" aria-hidden={!menuOpen}>
        <div className="vl-drawer-head">
          <span className="vl-logo">
            <VigilLogo />
          </span>
          <button type="button" className="vl-drawer-close" aria-label="Close menu" onClick={() => setMenuOpen(false)}>
            <X />
          </button>
        </div>
        <div className="vl-drawer-links">
          {SECTIONS.map((s, i) => (
            <a
              key={s.id}
              href={`#${s.id}`}
              tabIndex={menuOpen ? 0 : -1}
              className={active === s.id ? 'is-active' : ''}
              onClick={() => setMenuOpen(false)}
            >
              <span className="mono">{String(i + 1).padStart(2, '0')}</span>
              {s.label}
            </a>
          ))}
        </div>
        <div className="vl-drawer-foot">
          <span className="vl-drawer-status">
            <span className={`vl-square ${t?.status === 'degraded' ? 'vl-square--alert' : ''}`} />
            {t ? `checkout-api ${t.deployedVersion} · ${t.status}` : 'Connecting to the live instance'}
          </span>
          <button
            type="button"
            className="vl-btn vl-btn--dark"
            tabIndex={menuOpen ? 0 : -1}
            onClick={() => {
              setMenuOpen(false);
              onLaunch();
            }}
          >
            <span>Open the War Room</span>
            <span className="vl-btn-icon">
              <ArrowRight />
            </span>
          </button>
        </div>
      </nav>

      {/* ───────────────────────── Hero ───────────────────────── */}
      <section className="vl-hero" id="top" ref={heroRef}>

        <header className="vl-nav">
          <a href="#top" className="vl-logo" aria-label="Vigil">
            <VigilLogo />
          </a>
          <nav className="vl-navlinks" aria-label="Primary">
            {SECTIONS.map((s, i) => (
              <a key={s.id} href={`#${s.id}`} className="vl-navlink" style={{ ['--d' as string]: `${0.04 + i * 0.06}s` }}>
                {s.label}
              </a>
            ))}
          </nav>
          <button
            type="button"
            className={`vl-burger ${menuOpen ? 'is-open' : ''}`}
            aria-label={menuOpen ? 'Close menu' : 'Open menu'}
            aria-expanded={menuOpen}
            aria-controls="vl-drawer"
            onClick={() => setMenuOpen((v) => !v)}
          >
            <span />
            <span />
            <span />
          </button>
        </header>

        <main className="vl-hero-main">
          <p className="vl-kicker vl-fade is-in" style={{ ['--d' as string]: '0.18s' }}>
            Incident response on Switch
          </p>
          <h1 className="vl-headline">
            <span className="vl-mask">
              <span className="vl-rise is-in" style={{ ['--d' as string]: '0.26s' }}>
                Agents fix the outage.
              </span>
            </span>
            <span className="vl-mask">
              <span className="vl-rise is-in vl-line" style={{ ['--d' as string]: '0.4s' }}>
                A person <span className="vl-accent">ships the fix.</span>
              </span>
            </span>
          </h1>
          <div className="vl-hero-actions">
            <button
              type="button"
              className="vl-btn vl-btn--dark vl-wipe is-in"
              style={{ ['--d' as string]: '0.56s' }}
              onClick={onLaunch}
            >
              <span>Open the War Room</span>
              <span className="vl-btn-icon">
                <ArrowRight />
              </span>
            </button>
            <a href="#how" className="vl-btn vl-btn--outline vl-wipe is-in" style={{ ['--d' as string]: '0.66s' }}>
              <span>See how it works</span>
            </a>
          </div>
        </main>

        <div className="vl-hero-foot">
          <p className="vl-hero-lede">
            <span className="vl-rise is-in" style={{ ['--d' as string]: '0.78s' }}>
              Vigil runs a production incident across three linked Switch rooms. A sentinel opens it, a patcher
              (Vigil's own, or Claude Code) writes and tests the fix, and the release gate waits for a person to
              type <strong>approve</strong> in the team's chat app.
            </span>
          </p>

          <div className="vl-status vl-fade is-in" style={{ ['--d' as string]: '0.9s' }} aria-live="polite">
            <div className="vl-status-head">
              <span>checkout-api · live</span>
              <span
                className={`vl-dot ${!snap ? 'vl-dot--off' : t?.status === 'degraded' ? 'vl-dot--alert' : ''}`}
                aria-hidden="true"
              />
            </div>
            {snap && t ? (
              <>
                <div className="vl-status-row">
                  <span>version</span>
                  <span>{t.deployedVersion}</span>
                </div>
                <div className="vl-status-row">
                  <span>5xx / p99</span>
                  <span className="tnum">
                    {t.metricsMeasured === false ? 'not measured' : `${t.errorRatePct}% · ${fmtMs(t.p99LatencyMs)}`}
                  </span>
                </div>
                <div className="vl-status-row">
                  <span>agents</span>
                  <span>
                    {agentsOnline}/{snap.switchState.agents.length} on WebSocket
                  </span>
                </div>
                <div className="vl-status-row">
                  <span>incident</span>
                  <span>{snap.activeIncident ? `${snap.activeIncident.incidentId} · ${snap.activeIncident.stage.replace(/_/g, ' ')}` : 'none'}</span>
                </div>
              </>
            ) : (
              <div className="vl-status-row">
                <span>{offline ? 'runtime not reachable' : 'connecting…'}</span>
                <span />
              </div>
            )}
          </div>
        </div>
      </section>

      {/* ───────────────────────── Overview ───────────────────────── */}
      <section className="vl-section" id="overview" aria-label="Overview">
        <p className="vl-kicker vl-fade" data-reveal="">
          Flip the Switch Hackathon · Track 01, Best Business Workflow
        </p>
        <div className="vl-mask" data-reveal="">
          <h2 className="vl-h1 vl-rise">
            Three rooms run the incident. <span className="vl-muted">One teammate </span>
            <span className="vl-accent">signs the release.</span>
          </h2>
        </div>
        <p className="vl-lead vl-fade" data-reveal="">
          Each stage of an outage lives in its own Switch room, with an <strong>exclusive role lease</strong>, a{' '}
          <strong>room document</strong> as its audit trail, and a <strong>directed link</strong> to the next room. Agents
          find the next hop at runtime. Nothing reaches production until a human says so in chat.
        </p>

        <div className="vl-flow" role="img" aria-label="Incidents room links to hotfix room, which links to releases room, which links back to incidents.">
          <RoomNode
            reveal="0s"
            role="Room 1 · Lease incident-commander"
            name="#vigil-incidents"
            agent="@vigil-sentinel"
            doc="blast-radius-dossier"
            lines={['Receives the service’s own 5xx alert webhook', 'Reads the regression commit from git', 'Claims command, then escalates']}
          />
          <RoomLink delay="0s" />
          <RoomNode
            reveal="0.1s"
            role="Room 2 · Lease patch-author"
            name="#vigil-hotfix"
            agent="@vigil-patcher"
            doc="patch-verification-report"
            outline
            lines={['git revert, or your coding agent’s diff', 'Real node --test run on the candidate', 'Staging replay of the production payload']}
          />
          <RoomLink delay="0.9s" />
          <div>
            <RoomNode
              reveal="0.2s"
              role="Room 3 · Lease release-gatekeeper"
              name="#vigil-releases"
              agent="@vigil-release-gate"
              doc="postmortem-inc-xxxx"
              ink
              lines={['Refuses approvals from agent identities', 'Reads policy from a room document', 'Restarts the service, runs 5 canaries']}
            />
            <div className="vl-human vl-fade" data-reveal="" style={{ ['--d' as string]: '0.35s' }}>
              <span className="vl-square" aria-hidden="true" />
              <span>
                <b>A teammate</b> types <span className="vl-code-inline">approve INC-2041 promote</span>
              </span>
            </div>
          </div>
        </div>
        <div className="vl-loop vl-fade" data-reveal="">
          <span>#vigil-releases</span>
          <i />
          <span>RESOLVED closes the lease in #vigil-incidents</span>
        </div>
      </section>

      {/* ───────────────────────── 01 Proof ───────────────────────── */}
      <section className="vl-section vl-section--panel" id="proof" aria-label="Proof">
        <div className="vl-eyebrow vl-fade" data-reveal="">
          <b>01</b> Proof
        </div>
        <div className="vl-mask" data-reveal="">
          <h2 className="vl-h2 vl-rise">
            Not a mock-up. <span className="vl-muted">Real commits, real restarts, real tests.</span>
          </h2>
        </div>

        <div className="vl-two">
          <div className="vl-table-wrap vl-fade" data-reveal="" style={{ marginTop: 0 }}>
            <table className="vl-table">
              <thead>
                <tr>
                  <th>Layer</th>
                  <th>What actually happens</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                <ProofRow layer="Service" what="checkout-api runs as its own Node process from a git working copy tagged v2.13.2." />
                <ProofRow layer="Regression" what="git apply a release patch, commit it under the author, restart the process on v2.14.0." />
                <ProofRow layer="Alert" what="The service measures its own 5xx rate and POSTs a webhook on the first failure." />
                <ProofRow layer="Fix" what="git revert of the bad commit, or git apply of your coding agent’s diff." />
                <ProofRow layer="Verify" what="node --test on the candidate, then boot it on a staging port and replay the failing request." />
                <ProofRow layer="Release" what="Promote restarts from the verified commit. Rollback resets to v2.13.2. Five HTTP canaries." />
                <ProofRow
                  layer="Seeded"
                  seeded
                  what="The three regression patches, and in Mode A the embedded Switch protocol server. Mode B uses a real Switch server."
                />
              </tbody>
            </table>
          </div>

          <div className="vl-live vl-fade" data-reveal="" style={{ ['--d' as string]: '0.12s' }}>
            <div className="vl-live-head">
              <span>
                <span className={`vl-dot ${!snap ? 'vl-dot--off' : t?.status === 'degraded' ? 'vl-dot--alert' : ''}`} />
                Live from the running instance
              </span>
              <span>{t?.pid ? `pid ${t.pid}` : ''}</span>
            </div>
            {snap && t ? (
              <>
                <div className="vl-live-stats">
                  <div className="vl-stat">
                    <div className="vl-stat-label">Deployed</div>
                    <div className="vl-stat-value mono" style={{ fontSize: 17 }}>
                      {t.deployedVersion}
                    </div>
                  </div>
                  <div className="vl-stat">
                    <div className="vl-stat-label">5xx · 60s</div>
                    <div className="vl-stat-value" style={{ color: t.errorRatePct > 2 ? 'var(--alert)' : undefined }}>
                      {t.metricsMeasured === false ? '—' : `${t.errorRatePct}%`}
                    </div>
                  </div>
                  <div className="vl-stat">
                    <div className="vl-stat-label">Requests · 60s</div>
                    <div className="vl-stat-value">{t.metricsMeasured === false ? '—' : (t.windowRequests ?? '–')}</div>
                  </div>
                </div>
                <ul className="vl-gitlog" aria-label="git log of the live working copy">
                  {(snap.checkoutRepo?.log ?? []).slice(0, 5).map((c) => (
                    <li key={c.sha}>
                      <span className="sha">{c.sha}</span>
                      <span className="msg">
                        {c.message}
                        <span className="who">{c.author.replace(/\s*<.*>$/, '')}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <div className="vl-live-empty">
                {offline
                  ? 'The Vigil runtime behind this page is not answering right now, so no live data is shown. Running it yourself? Start it with npm start and reload.'
                  : 'Connecting to the runtime…'}
              </div>
            )}
          </div>
        </div>
      </section>

      {/* ───────────────────────── 02 How it works ───────────────────────── */}
      <section className="vl-section" id="how" aria-label="How it works">
        <div className="vl-eyebrow vl-fade" data-reveal="">
          <b>02</b> How it works
        </div>
        <div className="vl-mask" data-reveal="">
          <h2 className="vl-h2 vl-rise">
            From first 5xx to postmortem. <span className="vl-muted">Nine steps, all in the open.</span>
          </h2>
        </div>
        <div className="vl-steps">
          {STEPS.map((s, i) => (
            <article key={s.title} className="vl-step vl-fade" data-reveal="" style={{ ['--d' as string]: `${(i % 3) * 0.06}s` }}>
              <div className="vl-step-num">{String(i + 1).padStart(2, '0')}</div>
              <h3 className="vl-step-title">{s.title}</h3>
              <p className="vl-step-body">{s.body}</p>
              <div className="vl-step-meta">
                <span>
                  room <b>{s.room}</b>
                </span>
                <span>
                  op <b>{s.op}</b>
                </span>
                {s.artifact && (
                  <span>
                    writes <b>{s.artifact}</b>
                  </span>
                )}
              </div>
            </article>
          ))}
        </div>
      </section>

      {/* ───────────────────────── 03 Your agent ───────────────────────── */}
      <section className="vl-section vl-section--panel" id="agent" aria-label="Bring your coding agent">
        <div className="vl-eyebrow vl-fade" data-reveal="">
          <b>03</b> Your agent
        </div>
        <div className="vl-mask" data-reveal="">
          <h2 className="vl-h2 vl-rise">
            Claude Code writes the fix. <span className="vl-muted">Vigil decides if it is real.</span>
          </h2>
        </div>
        <p className="vl-lead vl-fade" data-reveal="">
          Bind the coding agent you already use into <span className="vl-code-inline">#vigil-hotfix</span> through Switch
          Console. Vigil hands it <strong>patch-author</strong>, steps back into <strong>red-team-verifier</strong>, and runs
          the service’s own tests against whatever your agent actually wrote. A red candidate is discarded and never reaches the
          release room.
        </p>

        <div className="vl-two">
          <ol className="vl-list vl-fade" data-reveal="">
            <li>
              <span className="vl-list-n">A</span>
              <div>
                <div className="vl-list-t">Edit in place</div>
                <div className="vl-list-b">
                  Fix the live working copy, then post <span className="vl-code-inline">@vigil-patcher verify INC-2041</span>.
                  The verifier commits your uncommitted edits as the candidate.
                </div>
              </div>
            </li>
            <li>
              <span className="vl-list-n">B</span>
              <div>
                <div className="vl-list-t">Post the diff in chat</div>
                <div className="vl-list-b">A unified diff in a fenced block addressed to the verifier is applied with git apply.</div>
              </div>
            </li>
            <li>
              <span className="vl-list-n">C</span>
              <div>
                <div className="vl-list-t">Call the API</div>
                <div className="vl-list-b">
                  <span className="vl-code-inline">POST /api/incidents/INC-2041/stage-patch</span> returns 200 when verified and
                  422 with the failing checks when not.
                </div>
              </div>
            </li>
            <li>
              <span className="vl-list-n">→</span>
              <div>
                <div className="vl-list-t">Then the same bar for everyone</div>
                <div className="vl-list-b">
                  Applies cleanly, fault no longer reproduces on a staging port, every service test green. Otherwise{' '}
                  <span className="vl-code-inline">git reset --hard</span> and try again.
                </div>
              </div>
            </li>
          </ol>

          <div className="vl-fade" data-reveal="" style={{ ['--d' as string]: '0.12s' }}>
            <div className="vl-code-title">
              <span>#vigil-hotfix · example</span>
              <i>
                <b />
                <b />
                <b />
              </i>
            </div>
            <pre className="vl-code">
              <span className="c"># sentinel escalates with the live working copy path</span>
              {'\n'}
              <span className="h">@vigil-sentinel </span>
              <span className="w">[ESCALATE INC-2041 mode=external]</span>
              {'\n'}
              {'                 '}@claude-code fix it in .vigil-state/checkout-api-live-4020
              {'\n\n'}
              <span className="c"># Claude Code edits src/cartPricing.ts, then</span>
              {'\n'}
              <span className="h">@claude-code    </span>
              <span className="w">@vigil-patcher verify INC-2041</span>
              {'\n\n'}
              <span className="c"># the verifier, for real</span>
              {'\n'}
              <span className="p">$ </span>git commit -m "hotfix(INC-2041): candidate from Claude Code"
              {'\n'}
              <span className="p">$ </span>node --import tsx --test test/cartPricing.test.ts
              {'\n'}
              <span className="ok">ok 1</span> - USD standard checkout ($99.00) charges 10692 cents
              {'\n'}
              <span className="ok">ok 2</span> - JPY zero-decimal checkout (¥9,600) charges ¥10368
              {'\n'}
              <span className="ok">ok 3</span> - KRW zero-decimal checkout prices without throwing
              {'\n'}
              <span className="ok">ok 4</span> - Stacked promo codes are deduplicated and floored
              {'\n'}
              <span className="ok">ok 5</span> - Fraud declines release their inventory reservation
              {'\n'}
              <span className="p">$ </span>staging replay POST /api/checkout <span className="ok">→ HTTP 200</span>
              {'\n\n'}
              <span className="h">@vigil-patcher  </span>
              <span className="w">INC-2041: fix verified.</span> Handing off to #vigil-releases.
            </pre>
          </div>
        </div>
      </section>

      {/* ───────────────────────── 04 Safety ───────────────────────── */}
      <section className="vl-section" id="safety" aria-label="Safety">
        <div className="vl-eyebrow vl-fade" data-reveal="">
          <b>04</b> Safety
        </div>
        <div className="vl-mask" data-reveal="">
          <h2 className="vl-h2 vl-rise">
            Policy lives in the room. <span className="vl-muted">Not in the code.</span>
          </h2>
        </div>
        <p className="vl-lead vl-fade" data-reveal="">
          The gate has no model in it. It re-reads the <span className="vl-code-inline">release-safety-policy</span> room
          document on every approval. A teammate changes the rules by typing in chat, and an agent that tries the same is
          refused.
        </p>

        <div className="vl-table-wrap vl-fade" data-reveal="">
          <table className="vl-table">
            <thead>
              <tr>
                <th>Rule</th>
                <th>Enforced value{policy ? ' · live' : ' (defaults, runtime not reachable)'}</th>
                <th>Change it from chat</th>
                <th>On violation</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Human sign-off</td>
                <td>only people; agents are refused</td>
                <td className="mono">fixed</td>
                <td className="mono">REJECTED_AGENT_SENDER</td>
              </tr>
              <tr>
                <td>Incident binding</td>
                <td>approval must cite the open INC id</td>
                <td className="mono">fixed</td>
                <td className="mono">REJECTED_INCIDENT_MISMATCH</td>
              </tr>
              <tr>
                <td>Diff size cap</td>
                <td className="mono">{policy?.maxChangedLines ?? 40} changed lines</td>
                <td className="mono">set max diff 60</td>
                <td className="mono">REJECTED_DIFF_POLICY_VIOLATION</td>
              </tr>
              <tr>
                <td>Protected paths</td>
                <td className="mono">{(policy?.forbiddenPaths ?? ['.env', 'secret', 'auth-keys', 'migrations/drop']).join(', ') || 'none'}</td>
                <td className="mono">set forbidden paths .env,secret</td>
                <td className="mono">REJECTED_DIFF_POLICY_VIOLATION</td>
              </tr>
              <tr>
                <td>Approvers</td>
                <td className="mono">{(policy?.allowedApprovers ?? ['any-human']).join(', ')}</td>
                <td className="mono">set approvers sam</td>
                <td className="mono">REJECTED_UNAUTHORIZED_APPROVER</td>
              </tr>
              <tr>
                <td>Verified candidate</td>
                <td className="mono">{policy ? (policy.requireGreenMatrix ? 'green tests required' : 'advisory') : 'green tests required'}</td>
                <td className="mono">set green matrix on</td>
                <td className="mono">REJECTED_UNVERIFIED_PATCH</td>
              </tr>
              <tr>
                <td>Rollback</td>
                <td>always available to a verified human</td>
                <td className="mono">approve INC-xxxx rollback</td>
                <td className="mono">git reset --hard v2.13.2</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div className="vl-duo">
          <div className="vl-node vl-fade" data-reveal="">
            <div className="vl-node-role">Failover</div>
            <div className="vl-node-title">
              <span className="vl-square vl-square--alert" aria-hidden="true" />
              Crash the commander mid-incident
            </div>
            <ol className="vl-seq">
              <li>
                <span>gen 1</span>
                <span>The sentinel wedges. Its socket stays open but stops answering pings.</span>
              </li>
              <li>
                <span>takeover</span>
                <span>A standby reopens the same connection_id from the last cursor.</span>
              </li>
              <li>
                <span>evicted</span>
                <span>The server sends taken_over to the old socket. It halts for good.</span>
              </li>
              <li>
                <span>gen 2+</span>
                <span>The standby re-asserts incident-commander. The incident still closes.</span>
              </li>
            </ol>
          </div>
          <div className="vl-node vl-fade" data-reveal="" style={{ ['--d' as string]: '0.1s' }}>
            <div className="vl-node-role">Rooms with a lifecycle</div>
            <div className="vl-node-title">
              <span className="vl-square vl-square--outline" aria-hidden="true" />
              One workroom per incident
            </div>
            <ol className="vl-seq">
              <li>
                <span>create_room</span>
                <span>#hotfix-inc-2041 from the hotfix workroom template, with its own roles.</span>
              </li>
              <li>
                <span>link_rooms</span>
                <span>Linked from #vigil-hotfix so every agent can find it.</span>
              </li>
              <li>
                <span>post_message</span>
                <span>The verifier posts its red or green verdict there.</span>
              </li>
              <li>
                <span>archive_room</span>
                <span>Archived at closure. The log stays, new messages are refused.</span>
              </li>
            </ol>
          </div>
        </div>
      </section>

      {/* ───────────────────────── 05 Run it ───────────────────────── */}
      <section className="vl-section vl-section--panel" id="run" aria-label="Run it">
        <div className="vl-eyebrow vl-fade" data-reveal="">
          <b>05</b> Run it
        </div>
        <div className="vl-mask" data-reveal="">
          <h2 className="vl-h2 vl-rise">
            Clone, test, start. <span className="vl-muted">Then connect real chat.</span>
          </h2>
        </div>
        <div className="vl-two">
          <div className="vl-fade" data-reveal="">
            <div className="vl-code-title">
              <span>Mode A · zero setup</span>
              <i>
                <b />
                <b />
                <b />
              </i>
            </div>
            <pre className="vl-code">
              <span className="p">$ </span>git clone {REPO_URL}.git
              {'\n'}
              <span className="p">$ </span>cd Vigil && npm install
              {'\n'}
              <span className="p">$ </span>npm test
              {'\n'}
              <span className="p">$ </span>npm run build && npm start
              {'\n\n'}
              <span className="c"># open http://localhost:4010, then Open the War Room</span>
              {'\n'}
              <span className="c"># click a chaos button, watch the git log and pid change</span>
            </pre>
          </div>
          <ol className="vl-list vl-fade" data-reveal="" style={{ ['--d' as string]: '0.1s' }}>
            {MODE_B.map((m, i) => (
              <li key={m.t}>
                <span className="vl-list-n">{String(i + 1).padStart(2, '0')}</span>
                <div>
                  <div className="vl-list-t">{m.t}</div>
                  <div className="vl-list-b">{m.b}</div>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* ───────────────────────── 06 FAQ ───────────────────────── */}
      <section className="vl-section" id="faq" aria-label="FAQ">
        <div className="vl-eyebrow vl-fade" data-reveal="">
          <b>06</b> FAQ
        </div>
        <div className="vl-mask" data-reveal="">
          <h2 className="vl-h2 vl-rise">Short answers.</h2>
        </div>
        <div className="vl-faq vl-fade" data-reveal="">
          {FAQ.map((f, i) => (
            <details key={f.q} open={i === 0}>
              <summary>
                {f.q}
                <Plus aria-hidden="true" />
              </summary>
              <p>{f.a}</p>
            </details>
          ))}
        </div>
      </section>

      {/* ───────────────────────── Closing ───────────────────────── */}
      <section className="vl-cta" aria-label="Open the war room">
        <div className="vl-cta-inner">
          <p className="vl-kicker vl-fade" data-reveal="">
            {snap ? `${agentsOnline} agents connected right now` : 'Three agents, three rooms, one person'}
          </p>
          <div className="vl-mask" data-reveal="">
            <h2 className="vl-h1 vl-rise" style={{ marginTop: 8 }}>
              Watch the room work. Then <span className="vl-accent">break production.</span>
            </h2>
          </div>
          <div className="vl-hero-actions vl-fade" data-reveal="">
            <button type="button" className="vl-btn vl-btn--dark" onClick={onLaunch}>
              <span>Open the War Room</span>
              <span className="vl-btn-icon">
                <ArrowRight />
              </span>
            </button>
            <a href={REPO_URL} target="_blank" rel="noreferrer" className="vl-btn vl-btn--outline">
              <span>Read the code</span>
              <ArrowUpRight style={{ width: 15, height: 15 }} />
            </a>
          </div>
        </div>
      </section>

      <footer className="vl-footer">
        <div className="vl-footer-brand">
          <a href="#top" className="vl-logo" aria-label="Vigil, back to top">
            <VigilLogo />
          </a>
          <span>Built for the Flip the Switch Hackathon by WeMakeDevs and Switch AI · MIT License</span>
        </div>
        <nav>
          <a href={REPO_URL} target="_blank" rel="noreferrer">
            GitHub
          </a>
          <a href="#how">How it works</a>
          <a
            href="/app"
            onClick={(e) => {
              e.preventDefault();
              onLaunch();
            }}
          >
            Open the War Room
          </a>
        </nav>
      </footer>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------------------------
const STEPS: Array<{ title: string; body: string; room: string; op: string; artifact?: string }> = [
  {
    title: 'A regression ships',
    body: 'A release patch is committed to the service working copy and the process restarts on v2.14.0.',
    room: 'none yet',
    op: 'git apply · commit · restart',
  },
  {
    title: 'The service raises the alarm',
    body: 'Its first 5xx posts a webhook with the error, the stack trace and the failing payload.',
    room: '#vigil-incidents',
    op: 'alert webhook',
  },
  {
    title: 'The sentinel takes command',
    body: 'It claims the exclusive lease, reads the bad commit from git and writes the dossier.',
    room: '#vigil-incidents',
    op: 'assume_role',
    artifact: 'blast-radius-dossier',
  },
  {
    title: 'Escalate over the room link',
    body: 'The next room is discovered at runtime, then the patcher is addressed directly.',
    room: '#vigil-hotfix',
    op: 'list_linked_rooms · send_targeted_message',
  },
  {
    title: 'Patch',
    body: 'git revert of the regression commit, or the diff your coding agent wrote.',
    room: '#vigil-hotfix',
    op: 'assume_role patch-author',
  },
  {
    title: 'Verify',
    body: 'Real tests on the candidate commit, then a staging boot that replays the production request.',
    room: '#vigil-hotfix',
    op: 'create_room_document',
    artifact: 'patch-verification-report',
  },
  {
    title: 'The gate holds',
    body: 'A summary lands in the release room with the policy in force and the two commands a human can send.',
    room: '#vigil-releases',
    op: 'load_internal_documents',
  },
  {
    title: 'A teammate decides',
    body: 'approve promote restarts from the verified commit. approve rollback resets to v2.13.2.',
    room: '#vigil-releases',
    op: 'bridged chat message',
  },
  {
    title: 'Canary, postmortem, close',
    body: 'Five live probes, a postmortem document, leases released, the workroom archived.',
    room: '#vigil-releases → #vigil-incidents',
    op: 'archive_room · release_role',
    artifact: 'postmortem-inc-xxxx',
  },
];

const MODE_B = [
  { t: 'Run a Switch server', b: 'Switch Console on your machine, or the Switch Docker Compose stack on a host you control, with a chat app such as Mattermost.' },
  { t: 'Create a registration key', b: 'In the Switch dashboard, open API Keys and create a registration key.' },
  { t: 'Onboard the three agents', b: 'SWITCH_SERVER_URL=… SWITCH_REGISTRATION_KEY=… npm run onboard:switch' },
  { t: 'Start Vigil', b: 'npm start. On first start it creates the three linked rooms, their roles, documents and links.' },
  { t: 'Approve from chat', b: 'Break something, then type approve in your chat app. Only a person can.' },
];

const FAQ = [
  {
    q: 'Is any of this simulated?',
    a: 'The three regressions are patches we wrote so the demo is repeatable, and Mode A uses an embedded Switch protocol server so it runs with zero setup. Everything else is real: the service process, git commits and reverts, the test suite, the restarts, the measured error rate, the canary probes, and every room operation. Mode B swaps the embedded server for a real Switch Console server without changing the agents.',
  },
  {
    q: 'Is there an LLM in the loop?',
    a: 'Not in Vigil’s agents. The sentinel, patcher and gate are deterministic. The only model is the coding agent you choose to bind, and Vigil treats its output as untrusted: it is committed, tested and replayed before a human ever sees it.',
  },
  {
    q: 'What if my agent’s fix is wrong?',
    a: 'The tests or the staging replay go red, the verifier posts the failing checks in #vigil-hotfix, and the commit is discarded with git reset --hard. The release room never hears about it.',
  },
  {
    q: 'Would it still work without Switch?',
    a: 'No. Command is an exclusive role lease. The audit trail is room documents. Routing is room links. The human check is the participant id Switch attaches to a chat message. The policy is a room document. Take Switch away and none of it has anywhere to live.',
  },
];

// ---------------------------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------------------------
function RoomNode(props: {
  reveal: string;
  role: string;
  name: string;
  agent: string;
  doc: string;
  lines: string[];
  outline?: boolean;
  ink?: boolean;
}) {
  return (
    <div data-reveal="" style={{ height: '100%' }}>
    <div className="vl-node vl-wipe" style={{ ['--d' as string]: props.reveal, height: '100%' }}>
      <div className="vl-node-role">{props.role}</div>
      <div className="vl-node-title mono">
        <span
          className={`vl-square ${props.outline ? 'vl-square--outline' : ''} ${props.ink ? 'vl-square--ink' : ''}`}
          aria-hidden="true"
        />
        {props.name}
      </div>
      <ul className="vl-node-lines">
        {props.lines.map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
      <div className="vl-node-meta">
        <span>
          agent <b>{props.agent}</b>
        </span>
        <span>
          doc <b>{props.doc}</b>
        </span>
      </div>
    </div>
    </div>
  );
}

function RoomLink({ delay }: { delay: string }) {
  return (
    <div className="vl-link" aria-hidden="true">
      <span className="vl-packet" style={{ ['--d' as string]: delay }} />
    </div>
  );
}

function ProofRow({ layer, what, seeded }: { layer: string; what: string; seeded?: boolean }) {
  return (
    <tr>
      <td>{layer}</td>
      <td style={{ color: 'var(--soft)' }}>{what}</td>
      <td style={{ textAlign: 'right', paddingRight: 0 }}>
        <span className={`vl-tag ${seeded ? 'vl-tag--seeded' : 'vl-tag--real'}`}>{seeded ? 'seeded' : 'real'}</span>
      </td>
    </tr>
  );
}

