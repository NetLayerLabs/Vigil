# Turning a solo coding agent into an incident-response teammate with Switch

*How Switch rooms, roles and room documents let Claude Code fix a production bug while a human keeps the only key to production.*

Built for the Flip the Switch Hackathon (WeMakeDevs × Switch), Track 01: Best Business Workflow.
Live: https://vigil.netlayerlabs.com · Code: https://github.com/NetLayerLabs/Vigil

Every team that has adopted a coding agent has the same quiet problem: the agent is brilliant in one terminal and invisible everywhere else. During a production incident, that invisibility turns into risk. This post walks through Vigil, an incident-to-hotfix workflow built on Switch, shows a real run where Claude Code fixed a live bug, and lists what we learned about the Switch agent protocol along the way. If you are new to Switch, the protocol notes near the end should save you a few hours.

## The problem: three ways a solo agent fails during an outage

**It goes dark.** One engineer asks Claude Code to fix the checkout crash. It does, locally. The on-call lead sees nothing until a deploy lands, and nobody can review the reasoning, because it lived in a terminal that is already closed.

**Nobody holds command.** Two responders pick up the same alert. Two agents stage conflicting patches. Nobody knows which candidate was checked against which reproduction.

**It holds the deploy keys.** An agent with credentials can approve its own release. That is one prompt injection away from a self-inflicted outage.

These are coordination problems, not model problems. The fix is to put the agent in the same room as the people and let the room enforce the rules.

## What Switch gives you

Switch is open-source infrastructure for putting AI agents into team chat. The parts Vigil depends on:

- **Rooms.** A room is an append-only log with instructions, roles, documents and participants, bridged to a channel in your chat app (Vigil's live deployment uses Mattermost; Switch also bridges Slack, Discord and Telegram). People and agents read the same log.
- **The agent protocol.** One WebSocket for events in, HTTP operations out. Any client that speaks it can join a room, whatever framework built it.
- **Templates.** One YAML file that creates rooms, roles, documents, links and a kickoff message in one pass.
- **Roles.** Named jobs with instructions. An exclusive role has one holder at a time, which is exactly what "who is incident commander right now" needs.
- **Room documents.** Structured documents stored on the Switch server, with authorship enforced: an agent can only change what it created.
- **Room links.** Directed edges between rooms, so an agent can ask "where does this work go next" instead of hard-coding channel IDs.

## Three linked rooms

Vigil's template creates three rooms and links them in a cycle.

1. **`#vigil-incidents`.** The sentinel agent receives the service's 5xx alert, matches it to the suspect commit, claims the exclusive `incident-commander` role, writes a `blast-radius-dossier` room document, and follows the link to the hotfix room.
2. **`#vigil-hotfix`.** A patch author writes the fix: Vigil's own patcher, or your coding agent. Vigil's patcher then checks it: it reproduces the failure on the live service, runs the service's real test suite, boots the candidate on a staging port and replays the failing request. It writes `patch-verification-report` and follows the next link.
3. **`#vigil-releases`.** The release gate posts the candidate and waits. Only a person typing `approve INC-2041 promote` or `approve INC-2041 rollback` in chat changes production. After a deploy it runs five live canary probes, writes the postmortem, and follows the last link back to close the incident.

An honest note about the target: the checkout service is small and purpose-built, but it is a real Node/TypeScript process that Vigil runs from a git working copy. Its three regressions (a zero-decimal currency crash, a stacked-promo negative charge and an inventory lock leak) are real commits deployed with a restart. The "production" is a stand-in only in the sense that nobody's revenue depends on it.

## A real run: Claude Code fixes a live bug

On Nov 6, 2026, the live deployment ran on a self-hosted Switch server (switch-core 0.31.0) with Mattermost. A Claude Code session ran on the same host as its own unprivileged user and was bound into `#vigil-hotfix` through Switch Console as `@claude-code`, with the repository's `CLAUDE.md` as its brief.

- **17:32 UTC.** A visitor shipped the JPY regression. JPY checkouts started returning HTTP 500. The service raised its own alert, and the incident opened as `INC-2044`.
- The sentinel took `incident-commander`, wrote the dossier, opened a `#hotfix-INC-2044` workroom, and mentioned `@claude-code` in `#vigil-hotfix` with the failing request and the path to the live working copy.
- **Claude Code** reproduced the 500, traced it to the regression commit, and wrote a 12-line forward fix in `src/cartPricing.ts`: JPY and KRW restored at scale 1, and the `Partial` type and `!` assertions removed, so a missing currency is now a compile error instead of a crash at checkout. It replied `@vigil-patcher verify INC-2044`.
- **Vigil's patcher** committed the change as the candidate and passed all seven checks: the diff applies, the JPY failure no longer reproduces on staging, and the service's five pricing tests pass. It told `#vigil-releases` the fix was written by `claude-code`.
- **A person** typed `@vigil-release-gate approve INC-2044 promote` in Mattermost. The gate returned `APPROVED_PROMOTE`, restarted the service on the verified commit, and all five canary probes passed.
- **17:47 UTC.** `INC-2044` closed on `v2.14.1-hotfix`, fifteen minutes after it opened.

Earlier the same day, an approval posted by the `vigil-patcher` agent itself was refused with `REJECTED_AGENT_SENDER`. The agent can write and check code; it cannot ship it.

## Four ideas worth borrowing

### 1. Your coding agent writes the fix; another agent checks it

The hackathon brief says to take an agent you already use. In Vigil's external mode, Vigil's own patcher stops writing fixes. Switch Console binds Claude Code into `#vigil-hotfix`, the sentinel's escalation hands it the `patch-author` role, and Vigil's patcher takes `red-team-verifier` instead.

Claude Code can hand off three ways: edit the working copy and post `@vigil-patcher verify INC-xxxx`, post a unified diff in a diff code block, or call `POST /api/incidents/INC-xxxx/stage-patch`. Whichever it picks, the verifier commits the candidate and runs the same checks. A change that does not carry the fix never reaches the release room: a diff that applies cleanly but only adds a notes file is rejected with `422`, and the incident stays in the hotfix room.

### 2. Release policy that lives in a room document

The gate's limits are not constants in code. They live in a `release-safety-policy` room document:

```
# Release policy
The release gate checks these rules on every approval. It is plain code; no model decides.
...
## Settings
People change these from chat, for example `@vigil-release-gate set max diff 60`.
- max_changed_lines: 40
- forbidden_paths: .env, secret, auth-keys, migrations/drop
- require_green_matrix: true
- allowed_approvers: any-human
- min_canary_probes: 5
```

The gate re-reads that document on every approval. People change it from chat with a small grammar: `set max diff 60`, `set approvers priya,sam`, `set forbidden paths .env,secret`, `set green matrix on|off`, `set canary probes 3`.

When Priya types `set max diff 1`, the gate rewrites the document with `update_room_document`, and the next approval of the 12-line fix is rejected with `REJECTED_DIFF_POLICY_VIOLATION`. When she types `set approvers sam`, her own approval is refused and Sam's goes through. When an agent sends the same command, it is refused as an agent. The rules live in the room, so taking Switch away takes the rules with it.

### 3. Incident commander failover

Exclusive roles and connection fencing exist for the moment the commander's process dies mid-incident. Vigil's test suite and its offline preview demonstrate exactly that. A chaos button wedges the sentinel: its socket stays open but it stops answering pings. A standby sentinel reopens the same `connection_id` from the last acknowledged cursor. The server evicts the wedged socket with `evicted: taken_over`, which the old client treats as final. The new generation resumes the event stream without a gap and re-asserts the `incident-commander` role, and the incident completes under the new commander.

### 4. A throwaway workroom per incident

Rooms can be lifecycle objects, not just static channels. For each incident the sentinel creates `#hotfix-INC-xxxx` from a second template (with `create_room_from_yaml` on a real Switch server), with its own `patch-author` and `release-gatekeeper` roles and the stack trace in its instructions. It links the workroom from `#vigil-hotfix` with `link_rooms`, the verifier posts its verdict there, and the sentinel archives it with `archive_room` when the incident closes. Durable records stay in the three permanent rooms; the scratch space goes away.

## What we learned about the protocol

**Answer every ping first.** The server pings every few seconds and evicts a connection that stops answering. A handler that does slow work on the same code path gets its connection dropped. Vigil's client replies before it does anything else:

```ts
// Answer every `ping` synchronously, before any slow event work.
if ('type' in parsed && parsed.type === 'ping') {
  const pong = { type: 'pong', cursor: this.cursor };
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(pong));
  return;
}
```

**Act only when `addressed` is true.** By default a connection receives every message in its rooms. If three agents each react to every line, you get a feedback loop. Drop unaddressed messages before any handler runs.

**A new agent answers only its owner.** A freshly registered agent refuses messages from other agents and from teammates who are not its owner. Widen it with `update_agent_detail` and an `addressing` value. On switch-core an agent may not change its own setting, but it may change a sibling agent with the same owner, so Vigil's sentinel opens up the patcher and the gate, and the patcher opens up the sentinel.

**`taken_over` is final.** If a client reconnects after being taken over, it steals the connection back and the two clients fight forever. Set a permanent stop flag on that eviction and never reconnect.

**Give each document to the agent that edits it.** On a real Switch server only the agent that created a room document can edit or delete it, and a document created by a template has no agent author, so no agent can change it. We found this when policy edits from chat could not be saved. Now the release gate creates the policy document at startup, which makes it the owner.

**Read the real server's frames, not just the docs.** First contact with switch-core needed a few client changes: control frames arrive as `{event, data}`, operations act on the room the connection last joined with `connect_to_room`, and some argument names differ. Rooms are created from YAML with `create_room_from_yaml`. Test against a real server early.

## Try it

**Live:** open https://vigil.netlayerlabs.com/app, ship the JPY chaos release, and watch the sentinel take command in rooms that belong to a real Switch server. Press **Test Rogue Agent Block** while a fix waits for approval to see the gate refuse an agent. The page cannot approve anything; only a person in the chat app can.

**On your machine (offline preview):**

```bash
git clone https://github.com/NetLayerLabs/Vigil.git
cd Vigil
npm install
npm test          # 22 tests
npm run build
npm start         # http://localhost:4010
```

This boots an embedded server that speaks the Switch protocol, so the whole loop runs on one machine with test identities standing in for people. Open the War Room, ship a chaos release, try a bad diff, tighten the policy from the chat bar, crash and fail over the sentinel, then approve and watch the canaries and the postmortem land.

**With your own Switch server:** run Switch Console or Switch's Docker Compose stack with a chat bridge, create a registration key, run `npm run onboard:switch`, then `npm start`. Vigil creates the three linked rooms itself. Bind your coding agent to `#vigil-hotfix` and approve from your chat app. The README has the details.

Code: https://github.com/NetLayerLabs/Vigil
