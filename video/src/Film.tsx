import React from "react";
import { AbsoluteFill, Audio, Freeze, Sequence, interpolate, staticFile, useCurrentFrame } from "remotion";
import { T } from "./timing";
import { C } from "./theme";
import { Captions } from "./ui/Captions";
import { Grain } from "./ui/Grain";
import { clamp } from "./ui/motion";
import { effects } from "./sfx";
import { Break, Chat, Close, Gap, Open, Problem, Rogue, Ship, SwitchScene, Team, Turn, Unique, Verify } from "./scenes/Scenes";

const SCENES: Record<string, React.FC> = {
  open: Open, problem: Problem, gap: Gap, turn: Turn, break: Break, chat: Chat,
  verify: Verify, rogue: Rogue, ship: Ship, team: Team, switch: SwitchScene, unique: Unique, close: Close,
};
const OVERLAP = 12; // frames each scene starts early, to dissolve over the last

/** Each scene eases in over the tail of the previous one, holding its first frame. */
const SceneIn: React.FC<{ S: React.FC; first: boolean }> = ({ S, first }) => {
  const f = useCurrentFrame();
  if (first) return <S />;
  const p = interpolate(f, [0, OVERLAP], [0, 1], { ...clamp, easing: (t) => 1 - Math.pow(1 - t, 3) });
  const body = f < OVERLAP ? <Freeze frame={0}><S /></Freeze> : <Sequence from={OVERLAP} layout="none"><S /></Sequence>;
  return <AbsoluteFill style={{ opacity: p, transform: `scale(${1.03 - 0.03 * p})`, filter: p < 1 ? `blur(${(1 - p) * 10}px)` : undefined }}>{body}</AbsoluteFill>;
};

// Music, ducked under every spoken line.
const LINES = T.scenes.flatMap((s) => s.lines.map((l) => [l.startFrame, l.words[l.words.length - 1].end] as const));
const DUCK: number[] = (() => {
  const v = new Array<number>(T.totalFrames + 1).fill(0);
  for (let f = 0; f <= T.totalFrames; f++) {
    let d = 0;
    for (const [a, b] of LINES) d = Math.max(d, interpolate(f, [a - 10, a, b, b + 14], [0, 1, 1, 0], clamp));
    v[f] = d;
  }
  return v;
})();
const musicVolume = (f: number) => {
  const end = T.totalFrames;
  const fadeIn = interpolate(f, [0, 20], [0, 1], clamp);
  const fadeOut = interpolate(f, [end - 60, end], [1, 0], clamp);
  return (0.5 - 0.36 * DUCK[Math.min(end, Math.max(0, f))]) * fadeIn * fadeOut;
};

// Captions sit out where big type already carries the words.
const QUIET = ["gap", "turn", "unique", "close"];
const hideCaptions = (f: number) => {
  const s = T.scenes.find((x) => f >= x.from && f < x.from + x.durationInFrames);
  return !s || QUIET.includes(s.id);
};

type TLine = { file: string; startFrame: number; durationFrames: number; estimated?: boolean };
const hasMusic = (T as unknown as { music: { source: string } }).music.source !== "unknown";

export const Film: React.FC = () => (
  <AbsoluteFill style={{ background: C.bg }}>
    {T.scenes.map((s, i) => {
      const S = SCENES[s.id];
      const from = i === 0 ? s.from : s.from - OVERLAP;
      const dur = s.durationInFrames + (i === 0 ? 0 : OVERLAP);
      return S ? (
        <Sequence key={s.id} from={from} durationInFrames={dur} name={s.id}>
          <SceneIn S={S} first={i === 0} />
        </Sequence>
      ) : null;
    })}
    <Grain opacity={0.035} />
    <Captions hidden={hideCaptions} bottom={34} />
    {hasMusic ? <Audio src={staticFile("audio/music.mp3")} volume={musicVolume} /> : null}
    {T.scenes.flatMap((s) => (s.lines as TLine[]).filter((l) => !l.estimated).map((l) => (
      <Sequence key={l.file} from={l.startFrame} durationInFrames={l.durationFrames}><Audio src={staticFile(l.file)} /></Sequence>
    )))}
    {effects().map((x, i) => (
      <Sequence key={i} from={x.at} durationInFrames={x.dur ?? 150}><Audio src={staticFile(`audio/sfx/${x.file}.mp3`)} volume={x.vol} /></Sequence>
    ))}
  </AbsoluteFill>
);
