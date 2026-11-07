// Sound effects via ElevenLabs /v1/sound-generation. Skips files that already exist.
//   node scripts/sfx.mjs                 all missing
//   ONLY=stamp,impact node scripts/sfx.mjs   force regenerate some
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ROOT, post, retry } from "./env.mjs";

const SFX = {
  tick: ["Single crisp soft tick, like a checklist item being checked, close, dry, short", 0.5],
  whoosh: ["Soft fast airy whoosh, smooth cinematic transition, no music", 1.0],
  swoosh_up: ["Quick rising clean swoosh, bright, UI transition, no music", 0.9],
  click: ["Soft modern mouse click, single, clean, short", 0.5],
  pop: ["Soft subtle UI pop, single, clean, short", 0.5],
  riser: ["Tension riser, rising airy synth swell building to a peak, cinematic, no drums", 3],
  impact: ["Deep clean cinematic impact with a warm sub tail, modern, single hit", 2],
  chime: ["Bright clean confirmation chime, two soft ascending notes, modern, short tail", 1.5],
  denied: ["Firm low digital access denied tone, single, clean, short", 1.0],
  stamp: ["Firm rubber stamp hit on paper, single, close, dry", 0.6],
  typing: ["Fast soft keyboard typing on a laptop, close, dry, no music", 2.5],
  link: ["Soft magnetic click as two pieces lock together, satisfying, clean, short", 0.6],
  alert: ["Subtle low warning pulse from a monitoring dashboard, two short beeps, clean, not harsh", 1.0],
  message: ["Soft modern chat message notification blip, single, clean, short", 0.6],
  unlock: ["A small metal lock clicking open, crisp, satisfying, close", 0.8],
};

const dir = join(ROOT, "public/audio/sfx");
mkdirSync(dir, { recursive: true });
const only = process.env.ONLY ? process.env.ONLY.split(",") : null;

for (const [name, [text, dur]] of Object.entries(SFX)) {
  const f = join(dir, `${name}.mp3`);
  if (only ? !only.includes(name) : existsSync(f)) { console.log(`${name}: skip`); continue; }
  try {
    const buf = await retry(async () => {
      const res = await post("/sound-generation?output_format=mp3_44100_128", { text, duration_seconds: dur, prompt_influence: 0.5 });
      return Buffer.from(await res.arrayBuffer());
    });
    writeFileSync(f, buf);
    console.log(`${name}: ${(buf.length / 1024).toFixed(0)}kb`);
  } catch (e) { console.error(`${name}: FAILED ${e.message}`); }
}
