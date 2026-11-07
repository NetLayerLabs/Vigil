import React from "react";
import { AbsoluteFill, Freeze, OffthreadVideo, Sequence, interpolate, staticFile, useCurrentFrame } from "remotion";
import footage from "../footage.json";
import { C, mono, sans } from "../theme";
import { clamp, soft } from "./motion";

export interface Rect { x: number; y: number; w: number; h: number }
export interface Clip { file: string; width: number; height: number; durationFrames: number; marks?: Record<string, number>; rects?: Record<string, Rect | null> }
const LIB = footage as unknown as Record<string, Clip>;
export const clip = (name: string): Clip | undefined => LIB[name];
export const markOf = (name: string, m: string) => clip(name)?.marks?.[m] ?? 0;

/** The page every clip was recorded at, in CSS pixels. */
export const PAGE = { w: 1600, h: 900 };

/** A camera keyframe: at local frame `f`, centre on `rect` (page CSS px) at `z` times the fit. Keep z small: the screen must read. */
export interface Cam { f: number; rect?: Rect; z?: number }

function camAt(f: number, cams: Cam[]) {
  const pts = cams.map((c) => ({ f: c.f, z: c.z ?? 1, cx: c.rect ? c.rect.x + c.rect.w / 2 : PAGE.w / 2, cy: c.rect ? c.rect.y + c.rect.h / 2 : PAGE.h / 2 }));
  if (!pts.length) return { z: 1, cx: PAGE.w / 2, cy: PAGE.h / 2 };
  if (f <= pts[0].f) return pts[0];
  for (let i = 1; i < pts.length; i++) {
    if (f <= pts[i].f) {
      const a = pts[i - 1], b = pts[i];
      const t = interpolate(f, [a.f, b.f], [0, 1], { ...clamp, easing: soft });
      return { z: a.z + (b.z - a.z) * t, cx: a.cx + (b.cx - a.cx) * t, cy: a.cy + (b.cy - a.cy) * t };
    }
  }
  return pts[pts.length - 1];
}

/**
 * A browser window playing a recording of the live product. `startFrom` is the clip frame shown at
 * local frame 0; the clip holds its last frame (or `stopAt`) if the scene outlasts it.
 */
export const Browser: React.FC<{
  name: string; url: string; width: number; left: number; top: number;
  startFrom?: number; cams?: Cam[]; enter?: number; exit?: number; dark?: boolean; stopAt?: number; rate?: number;
  /** Hold the first frame for this many local frames before playing. */ hold?: number;
}> = ({ name, url, width, left, top, startFrom = 0, cams = [], enter = 0, exit, dark, stopAt, rate = 1, hold = 0 }) => {
  const f = useCurrentFrame();
  const c = clip(name);
  const bar = 40;
  const vh = (width * PAGE.h) / PAGE.w;
  const k = width / PAGE.w;
  const cam = camAt(f, cams);
  const s = cam.z;
  const tx = Math.min(0, Math.max(width - PAGE.w * k * s, width / 2 - cam.cx * k * s));
  const ty = Math.min(0, Math.max(vh - PAGE.h * k * s, vh / 2 - cam.cy * k * s));
  const inP = interpolate(f, [enter, enter + 18], [0, 1], { ...clamp, easing: soft });
  const outP = exit != null ? interpolate(f, [exit, exit + 12], [0, 1], { ...clamp, easing: soft }) : 0;
  const last = Math.min(c ? c.durationFrames - 2 : 0, stopAt ?? Infinity);
  const pos = startFrom + Math.max(0, f - hold) * rate;
  const video = c ? <OffthreadVideo src={staticFile(c.file)} startFrom={Math.round(startFrom)} playbackRate={rate} muted style={{ width: PAGE.w, height: PAGE.h }} /> : null;
  const player = f < hold ? <Freeze frame={0}>{video}</Freeze> : pos >= last ? <Freeze frame={Math.max(0, Math.floor((last - startFrom) / rate))}>{video}</Freeze> : <Sequence from={hold} layout="none">{video}</Sequence>;
  return (
    <div style={{
      position: "absolute", left, top, width, height: vh + bar, borderRadius: 14, overflow: "hidden", background: dark ? "#1a1a19" : "#ffffff",
      boxShadow: dark ? "0 0 0 1px rgba(255,255,255,0.12), 0 40px 100px rgba(0,0,0,0.55)" : "0 0 0 1px rgba(10,10,10,0.10), 0 40px 90px rgba(10,30,20,0.18)",
      opacity: inP * (1 - outP), transform: `translateY(${(1 - inP) * 40 - outP * 24}px) scale(${0.975 + 0.025 * inP})`,
    }}>
      <div style={{ height: bar, display: "flex", alignItems: "center", gap: 8, padding: "0 16px", background: dark ? "#1a1a19" : "#ecece7", borderBottom: dark ? "1px solid rgba(255,255,255,0.08)" : "1px solid #dcdcd5" }}>
        {[0, 1, 2].map((i) => <span key={i} style={{ width: 11, height: 11, borderRadius: 6, background: dark ? "rgba(255,255,255,0.18)" : "#cfcfc8" }} />)}
        <div style={{ marginLeft: 14, flex: 1, height: 25, borderRadius: 7, background: dark ? "rgba(255,255,255,0.06)" : "#ffffff", display: "flex", alignItems: "center", padding: "0 14px", fontFamily: mono, fontSize: 14, color: dark ? "rgba(255,255,255,0.62)" : "#55554f", letterSpacing: "0.01em" }}>
          <span style={{ width: 7, height: 7, borderRadius: 4, background: C.brand, marginRight: 10 }} />{url}
        </div>
      </div>
      <div style={{ position: "relative", width, height: vh, overflow: "hidden", background: "#fff" }}>
        <div style={{ position: "absolute", left: 0, top: 0, width: PAGE.w, height: PAGE.h, transformOrigin: "0 0", transform: `translate(${tx}px, ${ty}px) scale(${k * s})` }}>
          {c ? player : (
            <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", fontFamily: sans, color: "#888", fontSize: 28 }}>footage “{name}” missing</AbsoluteFill>
          )}
        </div>
      </div>
    </div>
  );
};
