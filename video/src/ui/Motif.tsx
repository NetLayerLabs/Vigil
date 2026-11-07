import React from "react";
import { interpolate, useCurrentFrame } from "remotion";
import { C, mono } from "../theme";
import { clamp, soft } from "./motion";

/**
 * The film's motif: the three linked Switch rooms as a rail, and the incident as one card that
 * travels between them. The last room carries a lock that only a person can open.
 */
export const ROOMS = ["#vigil-incidents", "#vigil-hotfix", "#vigil-releases"] as const;

const Lock: React.FC<{ open: number; refused: number; size?: number; ink: string }> = ({ open, refused, size = 20, ink }) => {
  const shackle = -7 * open;
  const color = open > 0.5 ? C.brand : refused > 0 ? C.danger : ink;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" style={{ overflow: "visible" }}>
      <path d={`M7 11 V8 a5 5 0 0 1 10 0 V${11 + shackle}`} fill="none" stroke={color} strokeWidth={2.4} strokeLinecap="round" transform={`translate(${open * 4} 0)`} />
      <rect x={4.5} y={11} width={15} height={11} rx={2.5} fill={color} />
    </svg>
  );
};

export const RoomRail: React.FC<{
  /** Keyframes of the incident card's position: room index 0..2 (fractions glide between rooms). */
  path?: { f: number; at: number }[];
  dark?: boolean; top?: number; left?: number; width?: number; enter?: number;
  /** Frames at which an agent's approval is refused, and the lock opens for a person. */
  refuseAt?: number; openAt?: number; label?: string; hideCard?: boolean; dim?: number;
}> = ({ path = [{ f: 0, at: 0 }], dark, top = 22, left = 180, width = 1560, enter = 0, refuseAt, openAt, label = "INC-2046", hideCard, dim = 1 }) => {
  const f = useCurrentFrame();
  const ink = dark ? "#fff" : C.paperInk;
  const muted = dark ? "rgba(255,255,255,0.55)" : C.paperMuted;
  const edge = dark ? "rgba(255,255,255,0.18)" : "rgba(10,10,10,0.16)";
  const inP = interpolate(f, [enter, enter + 16], [0, 1], { ...clamp, easing: soft });
  let pos = path[0].at;
  for (let i = 1; i < path.length; i++) {
    if (f >= path[i - 1].f) pos = interpolate(f, [path[i - 1].f, path[i].f], [path[i - 1].at, path[i].at], { ...clamp, easing: soft });
  }
  const slot = width / 3;
  const refused = refuseAt != null ? interpolate(f, [refuseAt, refuseAt + 4, refuseAt + 40], [0, 1, 0], clamp) : 0;
  const shake = refuseAt != null && f >= refuseAt && f < refuseAt + 18 ? Math.sin((f - refuseAt) * 1.9) * 5 * (1 - (f - refuseAt) / 18) : 0;
  const open = openAt != null ? interpolate(f, [openAt, openAt + 14], [0, 1], { ...clamp, easing: soft }) : 0;
  return (
    <div style={{ position: "absolute", left, top, width, height: 52, opacity: inP * dim, transform: `translateY(${(1 - inP) * -10}px)` }}>
      <div style={{ position: "absolute", left: slot / 2, right: slot / 2, top: 25, height: 1, background: edge }} />
      {ROOMS.map((r, i) => {
        const here = hideCard ? 1 : Math.max(0, 1 - Math.abs(pos - i));
        return (
          <div key={r} style={{ position: "absolute", left: i * slot + slot / 2, top: 6, transform: "translateX(-50%)", display: "flex", alignItems: "center", gap: 10,
            padding: "8px 16px", borderRadius: 999, background: dark ? "#141413" : "#ffffff", boxShadow: `0 0 0 1px ${here > 0.5 ? C.brand : edge}`,
            fontFamily: mono, fontSize: 17, color: here > 0.5 ? ink : muted, whiteSpace: "nowrap" }}>
            {r}
            {i === 2 ? <span style={{ display: "inline-block", transform: `translateX(${shake}px)` }}><Lock open={open} refused={refused} ink={muted} size={18} /></span> : null}
          </div>
        );
      })}
      {hideCard ? null : (
        <div style={{ position: "absolute", left: pos * slot + slot / 2, top: 50, transform: "translateX(-50%)", fontFamily: mono, fontSize: 14, letterSpacing: "0.06em",
          color: "#fff", background: open > 0.5 ? C.brandD : C.danger, padding: "4px 10px", borderRadius: 6, whiteSpace: "nowrap" }}>
          {label}{open > 0.5 ? " · shipped" : ""}
        </div>
      )}
    </div>
  );
};
