import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { scene, wordAt } from "../timing";
import { C, display, mono, sans } from "../theme";
import { clamp, expo, pop } from "../ui/motion";
import runJson from "../../data/run.json";
import eventsJson from "../events.json";
import run2Json from "../../data/run2_run.json";

/** Scene-local frame and word cues: rel("word", n) is when the nth "word" is spoken, scene-local. */
export function useCue(id: string) {
  const s = scene(id);
  const f = useCurrentFrame();
  const rel = (w: string, n = 0) => wordAt(id, w, n) - s.from;
  return { s, f, rel, dur: s.durationInFrames };
}

/** The real record of INC-2046, read back from the live API after the run (data/run.json). */
export const RUN = (runJson as unknown as {
  checkedAt: string;
  incident: {
    incidentId: string; openedAt: number; resolvedAt: number; finalVersion: string;
    alert: { errorMessage: string; httpStatus: number; deployedVersion: string };
    patchVerification: { author: string; changedLines: number; candidateSha: string; touchedFiles: string[]; testMatrix: { name: string; passed: boolean; detail: string }[] };
    canaryReport: { probesRun: number; probesPassed: number; details: string[] };
    gateDecisions: { reasonCode: string; senderName: string }[];
  };
}).incident;
export const RUN2 = (run2Json as unknown as { incident: typeof RUN }).incident;
export const SECONDS = Math.round((RUN.resolvedAt - RUN.openedAt) / 1000);
export const CHECKS = RUN.patchVerification.testMatrix;
export const PASSED = CHECKS.filter((c) => c.passed).length;

/** Clip frame of each real chat message (scripts/events.mjs). The three run clips share one clock. */
export const EV = (eventsJson as unknown as Record<string, Record<string, number>>).warroom;
/** The same for the second run, INC-2047, which a teammate (dora) approved. */
export const EV2 = (eventsJson as unknown as Record<string, Record<string, number>>).run2_mm_releases;

export const Fill: React.FC<{ bg: string; children: React.ReactNode; color?: string }> = ({ bg, children, color = "#fff" }) => (
  <AbsoluteFill style={{ background: bg, fontFamily: sans, color, overflow: "hidden" }}>{children}</AbsoluteFill>
);

/** Small mono kicker with a green square, as the War Room labels its panels. */
export const Kicker: React.FC<{ children: React.ReactNode; color?: string; size?: number; style?: React.CSSProperties; dot?: string }> = ({ children, color = "rgba(255,255,255,0.62)", size = 16, style, dot = C.brand }) => (
  <div style={{ fontFamily: mono, fontSize: size, letterSpacing: "0.04em", color, display: "flex", alignItems: "center", gap: 12, ...style }}>
    <span style={{ width: 9, height: 9, background: dot }} />{children}
  </div>
);

/** Fade, rise and un-blur for any block. */
export const In: React.FC<{ at: number; dur?: number; y?: number; x?: number; children: React.ReactNode; style?: React.CSSProperties; out?: number }> = ({ at, dur = 16, y = 22, x = 0, children, style, out }) => {
  const f = useCurrentFrame();
  const p = interpolate(f, [at, at + dur], [0, 1], { ...clamp, easing: expo });
  const o = out != null ? interpolate(f, [out, out + 10], [1, 0], clamp) : 1;
  return <div style={{ opacity: p * o, transform: `translate(${(1 - p) * x}px, ${(1 - p) * y}px)`, filter: p < 1 ? `blur(${(1 - p) * 6}px)` : undefined, ...style }}>{children}</div>;
};

/** A square-cornered card that pops in at `at` (Vigil's geometry is square, with hairline rules). */
export const Card: React.FC<{ at: number; left: number; top: number; width: number; dark?: boolean; accent?: string; children: React.ReactNode; style?: React.CSSProperties; out?: number }> = ({ at, left, top, width, dark, accent, children, style, out }) => {
  const f = useCurrentFrame();
  const p = pop(f, at);
  const o = interpolate(f, [at, at + 8], [0, 1], clamp) * (out != null ? interpolate(f, [out, out + 10], [1, 0], clamp) : 1);
  return (
    <div style={{
      position: "absolute", left, top, width, opacity: o, transform: `translateY(${(1 - p) * 24}px) scale(${0.96 + 0.04 * p})`, transformOrigin: "50% 100%",
      background: dark ? "#141413" : "#ffffff", color: dark ? "#fff" : C.paperInk, padding: "24px 28px",
      boxShadow: dark ? "0 0 0 1px rgba(255,255,255,0.12), 0 30px 70px rgba(0,0,0,0.5)" : "0 0 0 1px rgba(10,10,10,0.10), 0 24px 60px rgba(10,30,20,0.12)",
      borderTop: accent ? `3px solid ${accent}` : undefined, fontFamily: sans, ...style,
    }}>{children}</div>
  );
};

export const Head: React.FC<{ children: React.ReactNode; size?: number; style?: React.CSSProperties }> = ({ children, size = 92, style }) => (
  <div style={{ fontFamily: display, fontWeight: 600, fontSize: size, letterSpacing: "-0.04em", lineHeight: 1.02, ...style }}>{children}</div>
);

export const Mono: React.FC<{ children: React.ReactNode; size?: number; color?: string; style?: React.CSSProperties }> = ({ children, size = 18, color, style }) => (
  <span style={{ fontFamily: mono, fontSize: size, color, letterSpacing: "0.01em", ...style }}>{children}</span>
);

/** A stamp that slams in (a refusal code, a result). */
export const Stamp: React.FC<{ at: number; text: string; color: string; size?: number; rot?: number; style?: React.CSSProperties }> = ({ at, text, color, size = 30, rot = -3, style }) => {
  const f = useCurrentFrame();
  const p = pop(f, at);
  const o = interpolate(f, [at, at + 4], [0, 1], clamp);
  return (
    <div style={{ display: "inline-block", fontFamily: mono, fontWeight: 500, fontSize: size, color, border: `3px solid ${color}`, padding: "8px 18px", background: "rgba(255,255,255,0.96)",
      opacity: o, transform: `rotate(${rot}deg) scale(${1.5 - 0.5 * p})`, ...style }}>{text}</div>
  );
};

/** "23:49:39 UTC" from epoch ms. */
export const utc = (ms: number) => `${new Date(ms).toISOString().slice(11, 19)} UTC`;
