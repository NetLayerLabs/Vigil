# Turning a solo coding agent into an incident-response teammate with Switch

*Built for the Flip the Switch Hackathon by WeMakeDevs and Switch AI, Track 01: Best Business Workflow.*

Every team that has adopted a coding agent has the same quiet problem. The agent is brilliant in one terminal and invisible everywhere else. During a production incident that invisibility turns into risk. This post walks through Vigil, an incident-to-hotfix war room we built on Switch, and what we learned about the Switch agent protocol along the way.

## The problem: three failure modes of a solo agent during a SEV-1

**Solo agents go dark.** One engineer asks Claude Code to fix the checkout crash. It does, locally. The on-call lead sees nothing until a deploy lands. Nobody can review the reasoning, because the reasoning lived in a terminal that is already closed.

**Nobody holds command.** Two responders pick up the same alert. Two agents stage conflicting patches. Nobody knows which candidate was verified against which reproduction, and the chat thread becomes the only audit trail.

**Agents hold deploy keys.** An autonomous agent with credentials can approve its own release. That is one prompt injection away from a self-inflicted outage.

Vigil's thesis is that these are coordination problems, not model problems. The fix is to put the agent inside the same room as the humans and make the room enforce the rules.

## What Switch gives you

Switch is open source infrastructure for putting AI agents into team chat. The parts Vigil leans on:

- **Rooms.** Every channel in Slack, Discord, Telegram or Mattermost becomes a room: an append-only log with instructions, roles, documents and participants. Humans and agents read the same log.
- **The agent protocol.** One WebSocket for events in, HTTP for operations out. Any client that speaks it can join a room, no matter what framework built it.
- **Templates.** A YAML file that provisions rooms, agents, roles, documents, aliases and a kickoff message in one pass.
- **Roles.** Named jobs with instructions. Exclusive roles have a single holder at a time, which is exactly what you want for "who is incident commander right now".
- **Room documents.** Structured artifacts stored on the Switch server with authorship enforced: an agent can only change what it created.
- **Room links.** Directed edges between rooms, so an agent can ask "where does this work go next" instead of hardcoding channel IDs.

## Mapping the incident lifecycle onto three linked rooms

Vigil's template creates three rooms and links them in a cycle.

1. `#vigil-incidents`. The sentinel agent receives the 5xx webhook from the checkout service, correlates it to the suspect commit, claims the exclusive `incident-commander` lease, writes a `blast-radius-dossier` room document, and follows the room link to the hotfix room.
2. `#vigil-hotfix`. The patcher reproduces the fault against the live API with the exact payload from the dossier, stages a candidate, runs a regression matrix, writes `patch-verification-report`, and follows the next link.
3. `#vigil-releases`. The release gate posts the candidate for review and waits. Only a human reply of `approve INC-2041 promote` or `approve INC-2041 rollback` changes production. After promotion it runs five synthetic canary probes, writes the postmortem document, and follows the last link back to close the incident.

Two honest notes about the demo environment. The checkout service is small and purpose-built, but it is a real Node/TypeScript process that Vigil runs from a git-backed working copy. The three regressions (a zero-decimal currency crash, a stacked-promo negative charge, and an inventory lock leak) are real patch files committed and deployed with a restart, so the "production" being protected is a stand-in only in the sense that nobody's revenue depends on it. And for a zero-setup run, Vigil boots an embedded Switch server that implements the published protocol: registration, the WebSocket connection, ping and pong, roles, documents, links and the operations catalog. Mode B points the same agents at a real Switch Console server with its bundled Mattermost, which is where the approval happens in actual chat.

## Four things we think nobody else will have

### 1. Claude Code as the patch author, Vigil as the verifier

The hackathon brief says "take an agent you already use". So in external mode Vigil's own patcher stops writing fixes. Switch Console binds a local Claude Code session into `#vigil-hotfix`, the repo's `CLAUDE.md` briefs it, and the sentinel's escalation addresses it as `patch-author`. Vigil's patcher takes the `red-team-verifier` role instead.

Claude Code reproduces the fault, writes the fix, and hands the unified diff back in the room inside a ```` ```diff ```` fence addressed to the verifier (or over `POST /api/incidents/INC-xxxx/stage-patch`). The verifier reproduces independently, checks the diff for the fault's fix signatures, runs the regression matrix, and writes the report. A diff that does not actually carry the fix fails the matrix and never reaches the release room. We tested this with a cosmetic one-line diff: it was rejected with a `422` and the incident stayed in the hotfix stage.

### 2. Release policy that lives in a Switch room document

The gate's limits used to be constants in code. Now they live in the `release-safety-policy` room document that the template creates:

```yaml
- name: "release-safety-policy"
  description: "Zero-LLM deterministic release gate invariants"
  instructions: "Enforced on every production deployment or rollback."
  content: |
    # Production Release Gate Policy
    ...
    ## Enforced Parameters
    Edited from chat by verified humans only (e.g. `@{team}-release-gate set max diff 60`). Re-read by the gate on every evaluation.
    - max_changed_lines: 40
    - forbidden_paths: .env, secret, auth-keys, migrations/drop
    - require_green_matrix: true
    - allowed_approvers: any-human
    - min_canary_probes: 5
```

The gate loads that document on every approval and parses the parameters block. Humans change it from chat with a small grammar:

```ts
/**
 * Parse a chat policy-change command. Grammar (case-insensitive):
 *   set max diff 60 | set max_changed_lines 60
 *   set approvers priya,sam | set approvers any
 *   set forbidden paths .env,secret | set forbidden paths none
 *   set green matrix on|off
 *   set canary probes 3
 */
```

When Priya types `set max diff 1`, the gate rewrites the document with `update_room_document` and the next `approve` of the 7-line candidate is rejected with `REJECTED_DIFF_POLICY_VIOLATION`. When she types `set approvers sam`, her own approval is refused and Sam's goes through. When an agent tries the same command, it is blocked as an agent sender. Governance moves into the room, and the question "would this stop working without Switch" answers itself.

### 3. Incident commander failover

Exclusive roles and connection fencing exist for the moment the commander's process dies mid-incident. Vigil demos exactly that. A chaos button wedges the live sentinel: its socket stays open but it stops answering pings. A standby sentinel then reopens the same `connection_id` from the last acknowledged cursor. The server evicts the wedged socket with `evicted: taken_over`, which the old client treats as final, the new generation resumes the event stream without a gap, and the standby re-asserts the `incident-commander` lease. The incident then completes through the new commander, and the closure callback lands on the standby, not the ghost.

### 4. Ephemeral per-incident workrooms

Rooms can be lifecycle objects, not just static channels. For each incident the sentinel instantiates `vigil-hotfix-workroom.template.yaml` through `create_room`, giving `#hotfix-inc-2041` its own `patch-author` and `release-gatekeeper` roles and the stack trace in its instructions. It links the workroom from `#vigil-hotfix` with `link_rooms`, posts the template's kickoff, and the verifier posts its red/blue verdict there. At closure the sentinel archives it with `archive_room`. Durable artifacts stay in the three permanent rooms; the scratch space goes away.

## What we learned about the protocol

**Answer every ping synchronously, before any event work.** The server pings every two seconds with a six-second TTL. A handler that does slow work on the same code path will get the connection evicted. Vigil's client replies first and dispatches second:

```ts
// 1. LIVENESS FIRST: Answer every `ping` synchronously before any slow event work!
if ('type' in parsed && parsed.type === 'ping') {
  const pong: SwitchPongFrame = { type: 'pong', cursor: this.cursor };
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(pong));
  }
  return;
}
```

**Act only when `payload.addressed` is true.** By default a connection receives every message in its rooms. If three agents each react to every line, you get a feedback loop. The client drops unaddressed messages before any handler runs.

**A new agent answers only its owner.** This one cost us a debugging session. A freshly registered agent refuses messages from other agents and from teammates who are not its owner. Call `update_agent_detail` with an `addressing` value after registration, or the sentinel-to-patcher handoff silently gets a refusal reply.

**`taken_over` is final.** If a client reconnects after being taken over, it steals the connection back and the two clients fight forever. The client sets a permanent stop flag on that eviction code and never reconnects.

**Template documents versus authorship.** Documents created by a template have no agent author. The release gate can update the policy document because of that, while a document an agent created can only be changed by that agent. Design your "shared editable" documents to come from the template and your "owned artifacts" to come from agents.

## Reproduce it

```bash
git clone https://github.com/NetLayerLabs/Vigil.git
cd Vigil
npm install
npm test
npm run build
npm start
```

Open `http://localhost:4010`, click **Open the War Room**, inject a chaos release, set the patch author to the external coder, paste a diff into the intake, tighten the policy from the chat bar, crash and fail over the sentinel, then approve as Priya and watch the canary probes and the postmortem land. The test suite covers every one of those paths.

The repo: https://github.com/NetLayerLabs/Vigil
