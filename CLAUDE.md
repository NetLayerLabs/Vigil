# Vigil — Switch Coding Teammate Instructions (`CLAUDE.md` / `AGENTS.md`)

When running inside **Switch Console** (via Claude Code, Antigravity, Codex, Cursor, or OpenCode) as `{team}-patcher` or `{team}-verifier` in `#vigil-hotfix`:

1. **Read Shared Switch Room Context First:**
   - Inspect the room's `instructions`, active `roles`, linked rooms (`#vigil-incidents` and `#vigil-releases`), and room-scoped documents (`blast-radius-dossier`, `reproduction-playbook`).
2. **Test-First Reproduction (Never Guess):**
   - Check live health and active fault state on the Checkout API (`GET http://localhost:4020/health` and `POST http://localhost:4020/api/checkout`).
   - Post the exact failing HTTP 500 stack trace and reproduction payload in `#vigil-hotfix` before modifying code.
3. **Minimal Surgical Patch:**
   - Stage patches via `POST http://localhost:4010/api/incidents/{incidentId}/stage-patch` or run `npm test` to verify all currency, promo-ledger, and inventory-lock invariants pass (`0` failures).
   - Keep diffs minimal (< 40 lines) and never modify `.env`, auth keys, or production deployment state directly.
4. **Cross-Room Handoff to Human Gate:**
   - Write or update the `patch-verification-report` room-scoped document in `#vigil-hotfix`.
   - Escalate to `#vigil-releases` addressing `@vigil-release-gate` so a human teammate can review and reply `approve <INC-ID> promote` or `approve <INC-ID> rollback`.
