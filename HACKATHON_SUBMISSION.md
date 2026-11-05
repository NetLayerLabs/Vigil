# 🏆 Flip the Switch Hackathon — Submission Packet (`Vigil`)

## Project Title
**Vigil — Autonomous Incident-to-Hotfix War Room on Switch**

## Track
**Track 01: Best Business Workflow (\$2,000)**  
*(Optional Side Entries: `#HowISwitch` Social Post + Best Blog)*

## Tagline (One Line)
Turn SEV-1 production outages into an auditable, multi-room team workflow in Mattermost, Discord, Telegram, or Slack — combining Switch WebSocket protocol agents, CLI coding agents, exclusive role leases, room documents, and a deterministic human release gate.

## How Switch Is Central (Would Stop Working Without Switch)
1. **Multi-Room Group Template (`templates/vigil-war-room.template.yaml`):** Provisions `#vigil-incidents`, `#vigil-hotfix`, and `#vigil-releases` with directed room links, exclusive roles (`incident-commander`, `patch-author`, `release-gatekeeper`), room-scoped documents, and service references in a single pass.
2. **Custom Switch WebSocket Agent Protocol Client (`src/protocol/switchClient.ts`):** Implements `GET /agents/{id}/connection/ws`, synchronous 2s `ping`/`pong` cursor liveness, `connection_state` generation fencing, `taken_over` terminal eviction handling, dynamic operation discovery (`GET /agents/{id}/ops`), and `X-Switch-Connection-Id` room operations.
3. **Shared Room Memory & Governance:** Every stage of an outage writes structured artifacts (`blast-radius-dossier`, `patch-verification-report`, `postmortem-inc-xxxx`) into Switch Room Documents and traverses `list_linked_rooms` — culminating in a deterministic human chat approval gate (`@switch-user-*` required; `@switch-agent-*` self-approvals deterministically blocked).

---

## 🎬 3-Minute Demo Video Script

- **0:00 – 0:25 | The Problem & Switch Setup:**  
  Open the Vigil landing page (`http://localhost:4010`) to frame the problem and the 3-room pipeline, then click **Launch App** to enter the War Room Observatory (`http://localhost:4010/app`) alongside Switch Console + Mattermost (or Discord/Telegram). Open `templates/vigil-war-room.template.yaml` showing how one Switch Group Template creates `#vigil-incidents`, `#vigil-hotfix`, `#vigil-releases`, exclusive roles, and room links.
- **0:25 – 1:15 | Chaos Outage & Multi-Room Agent Relay:**  
  Trigger **1. JPY Zero-Decimal 500** (`v2.14.0` crash on `checkout-api`). Show `@vigil-sentinel` assuming the `incident-commander` lease in `#vigil-incidents`, writing `blast-radius-dossier`, and traversing the room link to `#vigil-hotfix`. Show `@vigil-patcher` reproducing the exact `TypeError`, generating the 8-line fix, passing 5/5 regression vectors, writing `patch-verification-report`, and escalating to `#vigil-releases`.
- **1:15 – 2:05 | Adversarial Safety Check (Why Humans + Switch Matter):**  
  In `#vigil-releases`, click **Test Rogue Agent Block**. Show `@vigil-release-gate` immediately rejecting the AI self-approval (`REJECTED_AGENT_SENDER`) and keeping production untouched.
- **2:05 – 2:45 | Human Chat Sign-Off, Synthetic Canary & Blameless Postmortem:**  
  As Priya (`@switch-user-priya`), send `@vigil-release-gate approve INC-2041 promote` in chat. Watch `checkout-api` promote `v2.14.1-hotfix`, pass 5/5 live HTTP canary probes (`0%` error rate), publish `postmortem-inc-2041` in Room Docs, and close out `#vigil-incidents` releasing `incident-commander`.
- **2:45 – 3:00 | Live WebSocket Protocol Proof & Clone Reproducibility:**  
  Flash the **WS Protocol** tab (`connection_state`, `ping`/`pong` cursors, `POST /ops/...`) and `npm test` passing in <1 second.

---

## 📣 Ready-to-Post `#HowISwitch` Social Draft (Logitech Keyboard Side Prize)

> Just built **Vigil** for the Flip the Switch Hackathon by @WeMakeDevs_ & Switch AI! ⚡
>
> Instead of debugging outages in isolated terminals, Vigil wires 3 linked Switch Rooms (`#incidents` -> `#hotfix` -> `#releases`) directly into Mattermost/Discord:
> - `vigil-sentinel` correlates 500 stack traces & claims the exclusive `incident-commander` role lease
> - `vigil-patcher` reproduces the bug, runs a 5-vector regression matrix & writes a Switch Room Doc
> - `vigil-release-gate` blocks AI self-approvals and waits for human sign-off in chat before running synthetic canary probes & publishing the postmortem!
>
> Built over Switch's WebSocket Agent Protocol + v1 YAML Group Templates.
>
> Repo & demo: <YOUR_LINK> #HowISwitch
