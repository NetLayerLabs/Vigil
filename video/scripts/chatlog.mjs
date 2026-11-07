// Read-only: the Mattermost messages of one incident, from the three Vigil channels, into data/chat.json.
// Logs in with video/.capture.env (never printed).
import { readFileSync, writeFileSync } from "node:fs";
const env = Object.fromEntries(readFileSync(new URL("../.capture.env", import.meta.url), "utf8").split("\n").map((l) => l.match(/^([A-Z_]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2]]));
const base = env.MM_URL.replace(/\/$/, "") + "/api/v4";
const since = Number(process.argv[2]);
const login = await fetch(base + "/users/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ login_id: env.MM_USER, password: env.MM_PASS }) });
const token = login.headers.get("token");
const h = { Authorization: "Bearer " + token };
const get = async (p) => (await fetch(base + p, { headers: h })).json();
const teams = await get("/users/me/teams");
const out = {};
const users = {};
for (const name of ["vigil-incidents", "vigil-hotfix", "vigil-releases"]) {
  const ch = await get(`/teams/${teams[0].id}/channels/name/${name}`);
  const posts = await get(`/channels/${ch.id}/posts?since=${since}&per_page=200`);
  const list = Object.values(posts.posts || {}).filter((p) => p.create_at >= since).sort((a, b) => a.create_at - b.create_at);
  for (const p of list) if (!users[p.user_id]) users[p.user_id] = (await get(`/users/${p.user_id}`)).username;
  out[name] = list.map((p) => ({ at: new Date(p.create_at).toISOString(), user: users[p.user_id], message: p.message }));
}
writeFileSync(new URL("../data/chat.json", import.meta.url), JSON.stringify({ checkedAt: new Date().toISOString(), since: new Date(since).toISOString(), channels: out }, null, 1));
for (const [ch, ps] of Object.entries(out)) { console.log("## " + ch); for (const p of ps) console.log(p.at.slice(11, 19), p.user + ":", p.message.replace(/\s+/g, " ").slice(0, 260)); }
