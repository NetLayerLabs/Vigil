import { loadFont as loadInter } from "@remotion/google-fonts/Inter";
import { loadFont as loadMono } from "@remotion/google-fonts/GeistMono";
import { loadFont as loadSerif } from "@remotion/google-fonts/InstrumentSerif";

/** Vigil's own families (ui/theme.css): Inter for everything, Geist Mono for labels. */
export const sans = loadInter("normal", { weights: ["300", "400", "500", "600", "700"], subsets: ["latin"] }).fontFamily;
export const display = sans;
export const mono = loadMono("normal", { weights: ["400", "500"], subsets: ["latin"] }).fontFamily;
/** The one italic serif accent word per line. */
export const serif = loadSerif("italic", { weights: ["400"], subsets: ["latin"] }).fontFamily;

/** Vigil's palette (ui/theme.css): paper, ink and one green. */
export const C = {
  paper: "#f5f5f2",
  paperInk: "#0a0a0a",
  paperMuted: "#5c5c57",
  rule: "#d6d6cf",
  card: "#ffffff",
  bg: "#0a0a0a",
  raised: "#151514",
  ink: "#ffffff",
  muted: "rgba(255,255,255,0.62)",
  faint: "rgba(255,255,255,0.38)",
  brand: "#17c784",
  brandD: "#0e6b47",
  teal: "#17c784",
  danger: "#d2412f",
  dangerSoft: "#ffe6e1",
  warn: "#e0a33b",
  line: "rgba(255,255,255,0.14)",
};

export type Tone = "dark" | "light" | "brand";
export const TONE: Record<Tone, { bg: string; ink: string; muted: string; line: string; pill: string }> = {
  dark: { bg: C.bg, ink: "#ffffff", muted: "rgba(255,255,255,0.6)", line: "rgba(255,255,255,0.14)", pill: "rgba(10,10,10,0.72)" },
  light: { bg: C.paper, ink: C.paperInk, muted: C.paperMuted, line: "rgba(10,10,10,0.12)", pill: "rgba(255,255,255,0.86)" },
  brand: { bg: C.brandD, ink: "#ffffff", muted: "rgba(255,255,255,0.75)", line: "rgba(255,255,255,0.22)", pill: "rgba(6,50,33,0.55)" },
};

export const SCENE_TONE: Record<string, Tone> = {
  open: "dark", problem: "light", gap: "dark", turn: "light", break: "dark", chat: "dark",
  verify: "light", rogue: "dark", ship: "light", team: "light", switch: "light", unique: "brand", close: "light",
};
