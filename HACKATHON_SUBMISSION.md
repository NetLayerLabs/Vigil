# Flip the Switch Hackathon: submission packet (`Vigil`)

## Project Title
**Vigil — Autonomous Incident-to-Hotfix War Room on Switch**

## Track
**Track 01: Best Business Workflow (\$2,000)**  
*(Optional Side Entries: `#HowISwitch` Social Post + Best Blog)*

## Links
- **Live app:** https://vigil.netlayerlabs.com (War Room at `/app`), running against a real Switch server (switch-core 0.31.0)
- **Switch server:** https://vigil-switch.netlayerlabs.com · **Mattermost:** https://vigil-chat.netlayerlabs.com
- **Code:** https://github.com/NetLayerLabs/Vigil

## Tagline (One Line)
Turn SEV-1 production outages into an auditable, multi-room team workflow in Mattermost, Discord, Telegram, or Slack — combining Switch WebSocket protocol agents, CLI coding agents, exclusive role leases, room documents, and a deterministic human release gate.

## How Switch Is Central (Would Stop Working Without Switch)
1. **Multi-Room Group Template (`templates/vigil-war-room.template.yaml`):** Provisions `#vigil-incidents`, `#vigil-hotfix`, and `#vigil-releases` with directed room links, exclusive roles (`incident-commander`, `patch-author`, `release-gatekeeper`), room-scoped documents, and service references in a single pass.
2. **Custom Switch WebSocket Agent Protocol Client (`src/protocol/switchClient.ts`):** Implements `GET /agents/{id}/connection/ws`, synchronous 2s `ping`/`pong` cursor liveness, `connection_state` generation fencing, `taken_over` terminal eviction handling, dynamic operation discovery (`GET /agents/{id}/ops`), and `X-Switch-Connection-Id` room operations.
3. **Shared Room Memory & Governance:** Every stage of an outage writes structured artifacts (`blast-radius-dossier`, `patch-verification-report`, `postmortem-inc-xxxx`) into Switch Room Documents and traverses `list_linked_rooms` — culminating in a deterministic release gate that only a person on the chat bridge can open (agents, Switch itself and unknown senders are refused).

---

## 3-minute demo video script

- **0:00 – 0:25 | The Problem & Switch Setup:**  
  Open the Vigil landing page (`http://localhost:4010`) to frame the problem and the 3-room pipeline, then click **Open the War Room** to enter the War Room (`http://localhost:4010/app`), or use the live deployment at https://vigil.netlayerlabs.com with Mattermost. Open `templates/vigil-war-room.template.yaml` showing how one Switch Group Template creates `#vigil-incidents`, `#vigil-hotfix`, `#vigil-releases`, exclusive roles, and room links.
- **0:25 – 1:15 | Chaos Outage & Multi-Room Agent Relay:**  
  Trigger **01 JPY Zero-Decimal 500**: a real regression commit is applied to the checkout-api working copy and the process restarts on `v2.14.0`; the service raises a real alert webhook. Show `@vigil-sentinel` assuming the `incident-commander` lease in `#vigil-incidents`, writing `blast-radius-dossier`, and traversing the room link to `#vigil-hotfix`. Show `@vigil-patcher` reproducing the exact `TypeError`, doing a real `git revert` of the regression commit, passing the service's real test suite and a staging-port replay, writing `patch-verification-report`, and escalating to `#vigil-releases`.
- **1:15 – 2:05 | Adversarial Safety Check (Why Humans + Switch Matter):**  
  In `#vigil-releases`, click **Test Rogue Agent Block**. Show `@vigil-release-gate` immediately rejecting the AI self-approval (`REJECTED_AGENT_SENDER`) and keeping production untouched.
- **2:05 – 2:45 | Human chat sign-off, canaries and postmortem:**  
  As a person in chat (priya in Mattermost on the live site, or the Priya test identity locally), send `@vigil-release-gate approve INC-2041 promote`. Watch `checkout-api` promote `v2.14.1-hotfix`, pass its live HTTP canary probes (5 of 5 for the demo service), publish `postmortem-inc-2041` in Room Docs, and close out `#vigil-incidents` releasing `incident-commander`.
- **2:45 – 3:00 | Live WebSocket Protocol Proof & Clone Reproducibility:**  
  Flash the **WS Protocol** tab (`connection_state`, `ping`/`pong` cursors, `POST /ops/...`) and `npm test` passing (19 tests in about 11 seconds).

---

## Ready-to-post `#HowISwitch` social draft (Logitech keyboard side prize)

> Just built **Vigil** for the Flip the Switch Hackathon by @WeMakeDevs_ & Switch AI.
>
> Instead of debugging outages in isolated terminals, Vigil wires 3 linked Switch Rooms (`#incidents` -> `#hotfix` -> `#releases`) directly into Mattermost/Discord:
> - `vigil-sentinel` correlates 500 stack traces & claims the exclusive `incident-commander` role lease
> - `vigil-patcher` (or your Claude Code) fixes the bug; Vigil reproduces it, runs the real tests and replays the failing request before anyone is asked
> - `vigil-release-gate` refuses agent approvals and waits for a person in chat, then deploys, runs canary probes and writes the postmortem
>
> Built over Switch's WebSocket Agent Protocol + v1 YAML Group Templates.
>
> Repo & demo: https://github.com/NetLayerLabs/Vigil #HowISwitch
