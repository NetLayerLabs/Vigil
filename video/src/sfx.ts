import { T, scene, wordAt } from "./timing";
import list from "./sfx.json";

export interface Fx { file: string; at: number; vol: number; dur?: number }
/** Sound effects on words and cuts. Empty until scripts/sfx.mjs has generated the files (src/sfx.json lists them). */
export function effects(): Fx[] {
  const have = new Set((list as { files: string[] }).files);
  if (!have.size) return [];
  const sc = (id: string) => scene(id).from;
  const w = (id: string, word: string, n = 0) => wordAt(id, word, n);
  const fx: Fx[] = [
    { file: "whoosh", at: sc("problem") - 8, vol: 0.25 },
    ...["terminal.", "Two", "keys"].map((x, i) => ({ file: "pop", at: w("problem", x) - 6 - (i === 2 ? 2 : 0), vol: 0.35 })),
    { file: "riser", at: sc("turn") - 70, vol: 0.3 },
    { file: "impact", at: w("turn", "Vigil.") - 4, vol: 0.45 },
    { file: "whoosh", at: sc("break") - 8, vol: 0.25 },
    { file: "click", at: w("break", "bad"), vol: 0.45 },
    { file: "alert", at: w("break", "breaks") + 4, vol: 0.3 },
    { file: "whoosh", at: sc("chat") - 8, vol: 0.25 },
    { file: "message", at: w("chat", "hands") + 10, vol: 0.35 },
    { file: "typing", at: w("chat", "writes") - 6, vol: 0.2 },
    { file: "whoosh", at: sc("verify") - 8, vol: 0.25 },
    ...[0, 7, 14, 21, 28, 35, 42].map((d) => ({ file: "tick", at: w("verify", "tests") - 4 + d, vol: 0.28 })),
    { file: "chime", at: w("verify", "Seven") - 2, vol: 0.35 },
    { file: "whoosh", at: sc("rogue") - 8, vol: 0.25 },
    { file: "denied", at: w("rogue", "refuses.") - 2, vol: 0.5 },
    { file: "stamp", at: w("rogue", "refuses.") + 2, vol: 0.5 },
    { file: "swoosh_up", at: sc("ship") - 8, vol: 0.3 },
    { file: "message", at: w("ship", "message"), vol: 0.35 },
    { file: "unlock", at: w("ship", "deploys") + 4, vol: 0.45 },
    { file: "chime", at: w("ship", "Seventy-seven") - 2, vol: 0.4 },
    { file: "message", at: w("team", "approved") - 2, vol: 0.35 },
    { file: "unlock", at: w("team", "approved") + 30, vol: 0.4 },
    { file: "pop", at: w("team", "instructions") - 8, vol: 0.3 },
    { file: "whoosh", at: sc("switch") - 8, vol: 0.25 },
    { file: "link", at: w("switch", "carry") - 2, vol: 0.35 },
    { file: "swoosh_up", at: sc("unique") - 8, vol: 0.3 },
    ...["writes", "Another", "keys"].map((x) => ({ file: "pop", at: w("unique", x) - 6, vol: 0.3 })),
    { file: "whoosh", at: sc("close") - 8, vol: 0.25 },
    { file: "chime", at: w("close", "Vigil.") - 4, vol: 0.4 },
  ];
  return fx.filter((x) => have.has(x.file) && x.at >= 0 && x.at < T.totalFrames);
}
