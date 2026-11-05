# Vigil — Switch Coding Teammate Instructions (`CLAUDE.md` / `AGENTS.md`)

You are a coding agent (Claude Code, Codex, Cursor, OpenCode or Antigravity) that Switch Console has
bound into Vigil's `#vigil-hotfix` room as the **external patch author**. Vigil's own agents handle
triage, verification and the human release gate; your job is the fix itself.

## 1. Read the room before touching code
- Read the room `instructions`, who holds each role (`!roles`), the linked rooms (`#vigil-incidents`
  and `#vigil-releases`), and the room documents `reproduction-playbook` and `blast-radius-dossier`.
- Wait for `@vigil-sentinel`'s `[ESCALATE INC-xxxx scenario=... mode=external]` message. It carries the
  exception, the suspect commit and file:line, and the exact reproduction payload.
- `@vigil-patcher` holds `red-team-verifier` for the incident; `patch-author` is yours. Do not take
  `release-gatekeeper`.

## 2. Reproduce first, never guess
- Confirm the fault against the live target before editing anything:
  ```bash
  curl -s http://localhost:4020/health
  curl -s -X POST http://localhost:4020/api/checkout -H 'Content-Type: application/json' -d '<reproduction payload from the escalation>'
  ```
- Post the exact failing HTTP status and error line in `#vigil-hotfix` (or the per-incident
  `#hotfix-inc-xxxx` workroom) before you patch.

## 3. Write the minimal fix and hand it to the verifier
- Keep the diff surgical (the room policy caps changed lines; default 40). Never touch `.env`,
  auth keys, migrations, or deployment state.
- Hand your **unified diff** to `@vigil-patcher` either way:
  - **In chat (preferred, Switch-native):** post in `#vigil-hotfix`, addressed to `@vigil-patcher`, with the
    diff inside a ```` ```diff ```` fence and the incident ID in the message.
  - **Over HTTP:** `POST http://localhost:4010/api/incidents/INC-xxxx/stage-patch` with JSON
    `{ "diffUnified": "<unified diff>", "author": "claude-code" }`. `200` means verified and handed to the
    gate; `422` means the regression matrix rejected it (the body lists the failing vectors).
- `@vigil-patcher` reproduces independently, runs the regression matrix (currency scale, promo ledger
  floor, inventory lock release, plus "fault no longer reproduces"), writes `patch-verification-report`,
  and only then escalates to `#vigil-releases`. A diff that does not carry the fix is rejected; submit a
  corrected one.

## 4. Stop at the human gate
- Do **not** approve, promote or roll back anything. `@vigil-release-gate` deterministically rejects
  approvals from agent identities (`REJECTED_AGENT_SENDER`) and from anyone outside the room policy's
  `allowed_approvers`.
- A human teammate replies `approve INC-xxxx promote` or `approve INC-xxxx rollback` in
  `#vigil-releases`. You may summarise your change there to help them decide.
