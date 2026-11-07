// Places every real chat message of the run on a frame of each recorded clip (from data/chat.json
// timestamps and each clip's first screencast frame), into src/events.json. No guessing.
import { readFileSync, writeFileSync } from "node:fs";
const ROOT = new URL("..", import.meta.url).pathname;
const chat = JSON.parse(readFileSync(ROOT + "data/chat.json", "utf8"));
const t0 = (clip) => JSON.parse(readFileSync(`${ROOT}.cache/frames/${clip}/frames.json`, "utf8"))[0].t;
const at = (iso) => new Date(iso).getTime() / 1000;
const find = (ch, user, re) => {
  const p = chat.channels[ch].find((m) => m.user === user && re.test(m.message));
  if (!p) throw new Error(`no ${user} message matching ${re} in ${ch}`);
  return at(p.at);
};
const ev = {
  escalate: find("vigil-hotfix", "vigil-sentinel", /ESCALATE INC-2046/),
  claudeVerify: find("vigil-hotfix", "claude-code", /verify INC-2046/),
  fixVerified: find("vigil-hotfix", "vigil-patcher", /fix verified/),
  claudeDone: find("vigil-hotfix", "claude-code", /needs nothing more/),
  handoff: find("vigil-releases", "vigil-patcher", /HANDOFF INC-2046/),
  needsHuman: find("vigil-releases", "vigil-release-gate", /needs a human decision/),
  rogueApprove: find("vigil-releases", "vigil-patcher", /approve INC-2046 promote/),
  rogueRefused: find("vigil-releases", "vigil-release-gate", /REJECTED_AGENT_SENDER/),
  approve: find("vigil-releases", "priya", /approve INC-2046 promote/),
  deploying: find("vigil-releases", "vigil-release-gate", /deploying/),
  shipped: find("vigil-releases", "vigil-release-gate", /shipped/),
  opened: find("vigil-incidents", "vigil-sentinel", /INC-2046, SEV-1/),
  closed: find("vigil-incidents", "vigil-sentinel", /INC-2046 closed/),
};
const out = {};
for (const clip of ["warroom", "mm_hotfix", "mm_releases"]) {
  const s = t0(clip);
  out[clip] = Object.fromEntries(Object.entries(ev).map(([k, t]) => [k, Math.round((t - s) * 30)]));
}
writeFileSync(ROOT + "src/events.json", JSON.stringify(out, null, 1));
console.log(JSON.stringify(out));
