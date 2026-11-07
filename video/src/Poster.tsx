import React from "react";
import { AbsoluteFill, Img, staticFile } from "remotion";
import { C, mono, sans, serif } from "./theme";

/** The YouTube thumbnail: one big line, the real Mattermost screen from INC-2046, the logo. */
export const Poster: React.FC = () => (
  <AbsoluteFill style={{ background: C.paper, fontFamily: sans, color: C.paperInk, overflow: "hidden" }}>
    <div style={{ position: "absolute", left: 90, top: 80 }}>
      <Img src={staticFile("brand/vigil-header.png")} style={{ height: 78 }} />
    </div>
    <div style={{ position: "absolute", left: 90, top: 250, width: 900, fontSize: 128, fontWeight: 700, letterSpacing: "-0.05em", lineHeight: 0.98 }}>
      Claude Code fixed it.
      <div style={{ fontFamily: serif, fontStyle: "italic", fontWeight: 400, color: C.brandD, fontSize: 116, letterSpacing: "-0.02em", marginTop: 18, whiteSpace: "nowrap" }}>A person shipped it.</div>
    </div>
    <div style={{ position: "absolute", left: 96, bottom: 96, fontFamily: mono, fontSize: 30, color: C.paperMuted }}>Built on Switch · live in Mattermost</div>
    <div style={{ position: "absolute", left: 1010, top: 200, width: 1240, height: 640, overflow: "hidden", borderRadius: 14, transform: "rotate(-2deg)",
      boxShadow: "0 0 0 1px rgba(10,10,10,0.12), 0 50px 110px rgba(10,30,20,0.25)" }}>
      <Img src={staticFile("stills/mm-releases-end.png")} style={{ width: 1240 * 1.45, marginLeft: -390, marginTop: -150 }} />
    </div>
  </AbsoluteFill>
);
