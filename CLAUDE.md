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

## 3. Write the minimal fix in the live working copy and hand it to the verifier
- The service that is actually running is **not** `services/checkout-api` in this repo. Vigil runs it from a
  git-backed working copy whose path is in the escalation message (by default
  `.vigil-state/checkout-api-live-4020`). `HEAD` there is the regression commit; `git log -3` and
  `git show HEAD` tell you exactly what shipped. Edit `src/cartPricing.ts` **in that working copy**.
- Run the service's real tests there before handing off:
  ```bash
  cd .vigil-state/checkout-api-live-4020 && node --import tsx --test test/cartPricing.test.ts
  ```
- Keep the diff surgical (the room policy caps changed lines; default 40). Never touch `.env`,
  auth keys, migrations, or deployment state.
- Hand off to `@vigil-patcher` in one of three ways:
  - **Edit in place, then ask for verification (simplest):** leave your edits uncommitted in the working copy
    and post `@vigil-patcher verify INC-xxxx` in `#vigil-hotfix`. The verifier commits them as the candidate.
  - **Post the diff in chat:** `git diff` in the working copy, then post it addressed to `@vigil-patcher` inside a
    ```` ```diff ```` fence with the incident ID.
  - **Over HTTP:** `POST http://localhost:4010/api/incidents/INC-xxxx/stage-patch` with JSON
    `{ "diffUnified": "<unified diff>", "author": "claude-code" }`. `200` = verified and handed to the gate;
    `422` = rejected (body lists the failing checks).
- `@vigil-patcher` reproduces against the live process, commits your candidate, runs the real
  `node --test` suite, boots the candidate on a staging port and replays the production payload, writes
  `patch-verification-report`, and only then escalates to `#vigil-releases`. A red candidate is discarded
  (`git reset --hard` to the regression commit); fix and hand off again.

## 4. Stop at the human gate
- Do **not** approve, promote or roll back anything. `@vigil-release-gate` deterministically rejects
  approvals from agent identities (`REJECTED_AGENT_SENDER`) and from anyone outside the room policy's
  `allowed_approvers`.
- A human teammate replies `approve INC-xxxx promote` or `approve INC-xxxx rollback` in
  `#vigil-releases`. You may summarise your change there to help them decide.
