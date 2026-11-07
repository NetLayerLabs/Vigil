import React from "react";
import { Img, Sequence, interpolate, staticFile } from "remotion";
import { C, mono, sans, serif } from "../theme";
import { Browser, markOf } from "../ui/Footage";
import { RoomRail } from "../ui/Motif";
import { Words } from "../ui/Words";
import { Count } from "../ui/Count";
import { clamp, soft } from "../ui/motion";
import { CHECKS, Card, EV, Fill, Head, In, Kicker, Mono, PASSED, RUN, SECONDS, Stamp, useCue } from "./common";

// Layout shared by the footage scenes: the screen nearly full width, the rooms rail above it.
const MAIN = { width: 1560, left: 180, top: 118 };
const MM_URL = (ch: string) => `vigil-chat.netlayerlabs.com/vigil/channels/${ch}`;
const WAR_URL = "vigil.netlayerlabs.com/app";
// Regions of the 1600x900 pages, for gentle camera moves (z <= 1.25 so the screen always reads).
const R = {
  mmLower: { x: 270, y: 470, w: 1330, h: 430 },
  mmColumn: { x: 230, y: 60, w: 1370, h: 840 },
  warTop: { x: 0, y: 0, w: 1100, h: 110 },
  warRail: { x: 10, y: 380, w: 350, h: 260 },
  warMid: { x: 370, y: 520, w: 690, h: 330 },
  warRight: { x: 1060, y: 260, w: 540, h: 640 },
  warPatch: { x: 1060, y: 90, w: 540, h: 600 },
  graph: { x: 830, y: 190, w: 420, h: 280 },
  roles: { x: 90, y: 400, w: 1180, h: 300 },
};

/* 1. Open: the one line that ships. */
export const Open: React.FC = () => {
  const { f, rel } = useCue("open");
  const start = EV.approve - rel("Approve,");
  return (
    <Fill bg={C.bg}>
      <div style={{ position: "absolute", left: MAIN.left, top: 52 }}>
        <In at={4}><Kicker>Live · Mattermost #vigil-releases · {RUN.incidentId}, Nov 6, 2026</Kicker></In>
      </div>
      <Browser name="mm_releases" url={MM_URL("vigil-releases")} {...MAIN} startFrom={start} dark enter={0}
        />
      <div style={{ position: "absolute", right: 120, top: 50, opacity: interpolate(f, [rel("production.") - 6, rel("production.") + 10], [0, 1], clamp) }}>
        <Mono size={16} color="rgba(255,255,255,0.6)">typed by priya, a person</Mono>
      </div>
    </Fill>
  );
};

/* 2. Problem: three ways a solo agent fails during an outage. */
const ProblemCard: React.FC<{ at: number; left: number; glyph: string; title: string; body: string; danger?: boolean }> = ({ at, left, glyph, title, body, danger }) => (
  <Card at={at} left={left} top={430} width={520} accent={danger ? C.danger : C.paperInk} style={{ padding: "40px 40px", minHeight: 380 }}>
    <div style={{ fontFamily: mono, fontSize: 44, color: danger ? C.danger : C.paperInk, height: 70 }}>{glyph}</div>
    <div style={{ fontSize: 38, fontWeight: 600, letterSpacing: "-0.03em", lineHeight: 1.1, marginTop: 10 }}>{title}</div>
    <div style={{ fontSize: 24, color: C.paperMuted, marginTop: 14, lineHeight: 1.35 }}>{body}</div>
  </Card>
);
export const Problem: React.FC = () => {
  const { rel } = useCue("problem");
  return (
    <Fill bg={C.paper} color={C.paperInk}>
      <div style={{ position: "absolute", left: 150, top: 170 }}>
        <In at={2}><Kicker color={C.paperMuted}>The problem</Kicker></In>
        <In at={8}><Head size={80} style={{ marginTop: 22, maxWidth: 1500 }}>A coding agent in an outage, on its own.</Head></In>
      </div>
      <ProblemCard at={rel("terminal.") - 6} left={150} glyph="›_" title="Alone in one terminal" body="It finds the bug where nobody else can see it." />
      <ProblemCard at={rel("Two") - 6} left={700} glyph="A ≠ B" title="Two fixes, no owner" body="Two people stage two different patches." />
      <ProblemCard at={rel("keys") - 8} left={1250} glyph="⚿" title="It holds the keys" body="Nothing stops it shipping its own change." danger />
    </Fill>
  );
};

/* 3. Gap. */
export const Gap: React.FC = () => {
  const { rel } = useCue("gap");
  return (
    <Fill bg={C.bg}>
      <div style={{ position: "absolute", left: 200, right: 200, top: 330, textAlign: "center" }}>
        <Head size={96} style={{ color: "rgba(255,255,255,0.5)" }}><Words text="Not a smarter model." at={rel("missing") - 6} every={3} /></Head>
        <Head size={120} style={{ marginTop: 26 }}><Words text="A room with rules." at={rel("room") - 8} every={4} accent={{ "rules.": C.brand }} serifScale={1.18} /></Head>
      </div>
    </Fill>
  );
};

/* 4. Turn: logo and tagline. */
export const Turn: React.FC = () => {
  const { f, rel } = useCue("turn");
  const logoP = interpolate(f, [rel("Vigil.") - 6, rel("Vigil.") + 14], [0, 1], { ...clamp, easing: soft });
  return (
    <Fill bg={C.paper} color={C.paperInk}>
      <div style={{ position: "absolute", left: 0, right: 0, top: 250, display: "flex", justifyContent: "center", opacity: logoP, transform: `scale(${0.92 + 0.08 * logoP})` }}>
        <Img src={staticFile("brand/vigil-header.png")} style={{ height: 190 }} />
      </div>
      <div style={{ position: "absolute", left: 120, right: 120, top: 520, textAlign: "center" }}>
        <Head size={70}><Words text="Claude Code fixes the outage." at={rel("Claude") - 4} every={3} /></Head>
        <Head size={70} style={{ marginTop: 10 }}><Words text="A person ships it." at={rel("person") - 6} every={3} accent={{ person: C.brandD }} /></Head>
      </div>
      <div style={{ position: "absolute", left: 0, right: 0, top: 790, display: "flex", justifyContent: "center" }}>
        <In at={rel("Built") - 4}><Kicker color={C.paperMuted} size={20}>Built on Switch</Kicker></In>
      </div>
      <RoomRail top={900} enter={rel("Built") + 4} hideCard />
    </Fill>
  );
};

/* 5. Break: the live War Room as a bad release goes out. */
export const Break: React.FC = () => {
  const { rel } = useCue("break");
  const start = Math.max(0, markOf("warroom", "run.chaos") - rel("bad"));
  const local = (clipFrame: number) => clipFrame - start;
  return (
    <Fill bg={C.bg}>
      <RoomRail dark enter={4} path={[{ f: local(EV.opened) - 4, at: 0 }]} />
      <Browser name="warroom" url={WAR_URL} {...MAIN} startFrom={start} dark
        cams={[
          { f: 0, z: 1 },
          { f: rel("breaks") - 4, rect: R.warTop, z: 1 },
          { f: rel("breaks") + 18, rect: R.warTop, z: 1.15 },
          { f: rel("sentinel") - 4, rect: R.warTop, z: 1.15 },
          { f: rel("sentinel") + 16, rect: R.warMid, z: 1.08 },
          { f: rel("document.") - 14, rect: R.warMid, z: 1.08 },
          { f: rel("document.") + 8, rect: R.warRight, z: 1.12 },
        ]} />
    </Fill>
  );
};

/* 6. Chat: the hand-off to Claude Code in Mattermost, read back from the channel. */
export const Chat: React.FC = () => {
  const { rel } = useCue("chat");
  const scrollAt = markOf("story_hotfix", "story_hotfix.scroll");
  const hold = Math.max(0, rel("reproduces") - 24 - scrollAt);
  return (
    <Fill bg={C.bg}>
      <RoomRail dark path={[{ f: 0, at: 0 }, { f: rel("hands") + 18, at: 1 }]} />
      <Browser name="story_hotfix" url={MM_URL("vigil-hotfix")} {...MAIN} dark hold={hold}
        />
    </Fill>
  );
};

/* 7. Verify: Vigil's patcher checks the change on its own. */
export const Verify: React.FC = () => {
  const { f, rel } = useCue("verify");
  const start = markOf("warroom", "run.patchtab") - 8;
  const t0 = rel("tests") - 4;
  const staging = CHECKS.findIndex((c) => /staging/.test(c.name));
  return (
    <Fill bg={C.paper} color={C.paperInk}>
      <RoomRail path={[{ f: 0, at: 1 }]} />
      <Browser name="warroom" url={WAR_URL} width={1180} left={50} top={150} startFrom={start} cams={[{ f: 0, z: 1 }, { f: 40, rect: R.warPatch, z: 1.12 }]} />
      <Card at={rel("tests") - 14} left={1260} top={150} width={610} style={{ padding: "26px 28px" }}>
        <Mono size={15} color={C.paperMuted}>CANDIDATE {RUN.patchVerification.candidateSha} · BY {RUN.patchVerification.author.toUpperCase()}</Mono>
        <div style={{ marginTop: 16 }}>
          {CHECKS.map((c, i) => {
            const at = i === staging ? rel("replays") - 2 : t0 + i * 7;
            const p = interpolate(f, [at, at + 10], [0, 1], clamp);
            return (
              <div key={c.name} style={{ display: "flex", gap: 14, alignItems: "flex-start", padding: "10px 0", borderTop: i ? `1px solid ${C.rule}` : undefined, opacity: 0.25 + 0.75 * p }}>
                <span style={{ width: 14, height: 14, marginTop: 6, flex: "none", background: p > 0.5 ? C.brand : C.rule }} />
                <div>
                  <div style={{ fontSize: 19, lineHeight: 1.3 }}>{c.name}</div>
                  {i === staging ? <Mono size={14} color={C.brandD}>{c.detail.replace(/^staging :\d+ /, "staging ")}</Mono> : null}
                </div>
              </div>
            );
          })}
        </div>
      </Card>
      <div style={{ position: "absolute", left: 1260, top: 860 }}>
        <In at={rel("Seven") - 4}>
          <div style={{ fontSize: 76, fontWeight: 600, letterSpacing: "-0.04em" }}>
            <Count to={PASSED} at={rel("Seven") - 4} dur={20} /> <span style={{ fontFamily: serif, fontStyle: "italic", fontWeight: 400, color: C.brandD }}>of</span> {CHECKS.length} <span style={{ fontSize: 34, color: C.paperMuted, fontWeight: 500, letterSpacing: "-0.01em" }}>checks pass</span>
          </div>
        </In>
      </div>
    </Fill>
  );
};

/* 8. Rogue: an agent tries to approve its own release. */
export const Rogue: React.FC = () => {
  const { rel } = useCue("rogue");
  const start = EV.rogueApprove - rel("tries");
  const refusedLocal = EV.rogueRefused - start;
  return (
    <Fill bg={C.bg}>
      <RoomRail dark path={[{ f: 0, at: 2 }]} refuseAt={refusedLocal} />
      <Browser name="mm_releases" url={MM_URL("vigil-releases")} {...MAIN} startFrom={start} dark />
      <div style={{ position: "absolute", right: 150, top: 700 }}>
        <Stamp at={rel("refuses.") - 2} text="REJECTED_AGENT_SENDER" color={C.danger} size={34} />
      </div>
    </Fill>
  );
};

/* 9. Ship: a person approves, the gate deploys, the canaries answer. */
const Stat: React.FC<{ at: number; top: number; big: React.ReactNode; small: string }> = ({ at, top, big, small }) => (
  <Card at={at} left={1310} top={top} width={540} style={{ padding: "22px 28px" }}>
    <div style={{ fontSize: 50, fontWeight: 600, letterSpacing: "-0.035em", lineHeight: 1.05 }}>{big}</div>
    <div style={{ fontSize: 20, color: C.paperMuted, marginTop: 8 }}>{small}</div>
  </Card>
);
export const Ship: React.FC = () => {
  const { rel } = useCue("ship");
  const start = EV.approve - rel("message") - 10;
  const c = RUN.canaryReport;
  return (
    <Fill bg={C.paper} color={C.paperInk}>
      <RoomRail path={[{ f: 0, at: 2 }]} openAt={EV.shipped - start} />
      <Browser name="mm_releases" url={MM_URL("vigil-releases")} width={1200} left={60} top={150} startFrom={start} />
      <Stat at={rel("message") + 4} top={150} big={<span>priya</span>} small="approved in Mattermost: a person" />
      <Stat at={rel("canary") - 6} top={330} big={<span><Count to={c.probesPassed} at={rel("canary") - 6} dur={18} /> of {c.probesRun}</span>} small="canary probes answered after the deploy" />
      <Stat at={rel("postmortem") - 6} top={510} big={<span style={{ fontFamily: mono, fontSize: 34, letterSpacing: 0 }}>postmortem-inc-2046</span>} small="written to a Switch room document" />
      <Stat at={rel("Seventy-seven") - 6} top={690} big={<span><Count to={SECONDS} at={rel("Seventy-seven") - 6} dur={24} /> seconds</span>} small={`alert to closed · ${RUN.finalVersion} live`} />
    </Fill>
  );
};

/* 10. Switch: what holds it together, on the Switch dashboard. */
const DocChip: React.FC<{ at: number; left: number; name: string; room: string }> = ({ at, left, name, room }) => (
  <Card at={at} left={left} top={800} width={500} style={{ padding: "18px 24px", boxShadow: "0 0 0 1px rgba(10,10,10,0.12), 0 24px 60px rgba(10,30,20,0.28)" }}>
    <Mono size={22}>{name}</Mono>
    <div style={{ fontSize: 18, color: C.paperMuted, marginTop: 6 }}>room document in {room}</div>
  </Card>
);
export const SwitchScene: React.FC = () => {
  const { rel, dur } = useCue("switch");
  const a = rel("Three"), b = rel("carry"), c = rel("Exclusive"), d = rel("documents");
  const SW = "vigil-switch.netlayerlabs.com/rooms";
  return (
    <Fill bg={C.paper} color={C.paperInk}>
      <RoomRail hideCard enter={0} />
      <Sequence from={0} durationInFrames={b + 6} layout="none">
        <Browser name="switch" url={SW} {...MAIN} startFrom={Math.max(0, markOf("switch", "switch.row.vigil-incidents") - a)} />
      </Sequence>
      <Sequence from={b} durationInFrames={c - b + 6} layout="none">
        <Browser name="switch" url={`${SW} · graph view`} {...MAIN} enter={-30} startFrom={markOf("switch", "switch.graph") + 20} cams={[{ f: 0, z: 1 }, { f: 30, rect: R.graph, z: 1.18 }]} />
      </Sequence>
      <Sequence from={c} durationInFrames={d - c + 6} layout="none">
        <Browser name="switch" url="vigil-switch.netlayerlabs.com/rooms/vigil-hotfix" {...MAIN} enter={-30} startFrom={markOf("switch", "switch.room") + 10} cams={[{ f: 0, z: 1 }, { f: 30, rect: R.roles, z: 1.1 }]} />
      </Sequence>
      <Sequence from={d} durationInFrames={dur - d} layout="none">
        <Browser name="switch" url="vigil-switch.netlayerlabs.com/rooms/vigil-hotfix" {...MAIN} enter={-30} startFrom={markOf("switch", "switch.room") + 10} cams={[{ f: 0, rect: R.roles, z: 1.1 }]} />
      </Sequence>
      <DocChip at={d} left={215} name="blast-radius-dossier" room="#vigil-incidents" />
      <DocChip at={d + 12} left={710} name="patch-verification-report" room="#vigil-hotfix" />
      <DocChip at={d + 24} left={1205} name="release-safety-policy" room="#vigil-releases" />
    </Fill>
  );
};

/* 11. Unique: three claims, each with its proof from INC-2046. */
const Claim: React.FC<{ at: number; top: number; title: string; proof: string }> = ({ at, top, title, proof }) => (
  <div style={{ position: "absolute", left: 200, right: 200, top }}>
    <In at={at}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 36, borderTop: "1px solid rgba(255,255,255,0.25)", paddingTop: 22 }}>
        <div style={{ fontSize: 56, fontWeight: 600, letterSpacing: "-0.035em", width: 760, flex: "none" }}>{title}</div>
        <Mono size={21} color="rgba(255,255,255,0.82)">{proof}</Mono>
      </div>
    </In>
  </div>
);
export const Unique: React.FC = () => {
  const { rel } = useCue("unique");
  const v = RUN.patchVerification;
  return (
    <Fill bg={C.brandD}>
      <div style={{ position: "absolute", left: 200, right: 200, top: 150 }}>
        <Head size={82}><Words text="The agent you already use becomes a teammate." at={rel("agent") - 4} every={2} accent={{ "teammate.": "#9ff5cf" }} /></Head>
      </div>
      <Claim at={rel("writes") - 6} top={480} title="It writes the fix." proof={`${v.author} · ${v.changedLines} changed lines · commit ${v.candidateSha}`} />
      <Claim at={rel("Another") - 6} top={620} title="Another agent checks it." proof={`vigil-patcher · ${PASSED} of ${CHECKS.length} checks · staging replay HTTP 200`} />
      <Claim at={rel("keys") - 8} top={760} title="People keep the keys." proof="approved by priya · agent approval refused" />
    </Fill>
  );
};

/* 12. Close. */
export const Close: React.FC = () => {
  const { rel } = useCue("close");
  return (
    <Fill bg={C.paper} color={C.paperInk}>
      <div style={{ position: "absolute", left: 0, right: 0, top: 270, display: "flex", justifyContent: "center" }}>
        <In at={rel("Vigil.") - 8} y={12}><Img src={staticFile("brand/vigil-header.png")} style={{ height: 170 }} /></In>
      </div>
      <div style={{ position: "absolute", left: 0, right: 0, top: 500, textAlign: "center" }}>
        <In at={rel("Built") - 4}><div style={{ fontSize: 46, fontWeight: 600, letterSpacing: "-0.03em" }}>Claude Code fixes the outage. <span style={{ fontFamily: serif, fontStyle: "italic", fontWeight: 400, color: C.brandD }}>A person ships it.</span></div></In>
        <In at={rel("Live") - 4}>
          <div style={{ marginTop: 46, fontFamily: mono, fontSize: 28 }}>vigil.netlayerlabs.com</div>
          <div style={{ marginTop: 12, fontFamily: mono, fontSize: 22, color: C.paperMuted }}>github.com/NetLayerLabs/Vigil</div>
        </In>
      </div>
      <div style={{ position: "absolute", left: 0, right: 0, bottom: 90, display: "flex", justifyContent: "center" }}>
        <In at={rel("Built") + 6}><Kicker color={C.paperMuted} size={18}>Built on Switch · Flip the Switch Hackathon, Track 01</Kicker></In>
      </div>
      <div style={{ position: "absolute", left: 0, right: 0, bottom: 40, textAlign: "center", fontFamily: sans, fontSize: 15, color: C.paperMuted }}>
        Every screen in this film is a recording of the live deployment on Nov 6, 2026 (INC-2046).
      </div>
    </Fill>
  );
};
