# Vigil demo film

A film of under 3 minutes for the Flip the Switch Hackathon judges (Track 01). It shows a real incident, `INC-2046`, running on the live deployment: a chaos release broke checkout, Claude Code wrote the fix in Mattermost, Vigil's patcher checked it, an agent's approval was refused, and a person approved the release.

## What is real

- **The incident.** `INC-2046` ran on Nov 6, 2026 on vigil.netlayerlabs.com against the self-hosted Switch server (switch-core 0.31.0) and Mattermost. It opened at 23:48:21 UTC and closed at 23:49:39 UTC (77 seconds). Every figure in the film is read from `data/run.json`, which `scripts/capture.mjs` saved from `/api/state` right after the run: the 12-line fix by `claude-code` (commit `26c3213`), the 7 of 7 checks with their names, the 5 of 5 canary probes, and the gate's decisions.
- **The chat.** `data/chat.json` holds the incident's Mattermost messages, read back through the Mattermost API. `scripts/events.mjs` puts each one on a frame of the recordings, so cuts land on the real messages. Claude Code noticed by itself that this was the same regression as INC-2044, which is why it was fixed in seconds; the narration says so.
- **The footage.** All of it is the live product, recorded headless with Chrome at 1600x900 CSS px (`scripts/capture.mjs`):
  - `warroom`, `mm_hotfix`, `mm_releases`: three cameras recording at once during the run (screencast at 1600x900).
  - `story_hotfix`, `story_releases`, `story_incidents`: read-only scroll-backs of the same conversation afterwards, at 3200x1800.
  - `switch`: the Switch Gateway dashboard (rooms, graph view, the `vigil-hotfix` room and its roles), read only, at 3200x1800.
  - The pointer is drawn by the recorder because headless Chrome has none.
- **Writes made for the film.** One chaos release (`01 JPY Zero-Decimal 500`), Claude Code's own session, one **Test Rogue Agent Block** click (an agent approval the gate refused), and the approval, which the owner typed in Mattermost as `priya`. The recorder never approves anything. `ONLY=run` refuses to start unless `RUN=yes` is set, no incident is open and the patch mode is `external`.
- **Motion graphics.** The problem cards, the rooms rail and the claims are drawn from the real data above; no UI is mocked. The Mattermost clock shows the recording machine's time zone (UTC+1); the times quoted here are UTC.
- **Voice, music and sound.** ElevenLabs: narration by the voice Matilda (`eleven_multilingual_v2`), music from `/v1/music`, effects from `/v1/sound-generation`.

## Build it

The ElevenLabs key is read at runtime from `/Users/mrnetwork/Syntura/video/.env` (`scripts/env.mjs`) and never stored here. Logins for the recorder live in `video/.capture.env` (gitignored).

```bash
npm install
npm run vo && npm run timing        # narration, then word timing
npm run music && npm run timing     # music sized to the cut, timing again for the beat
npm run sfx                         # effects
ONLY=check node scripts/capture.mjs # test the logins (no writes)
# ONLY=run RUN=yes node scripts/capture.mjs   # the live run: makes the writes listed above
ONLY=switch,story_hotfix,story_releases,story_incidents node scripts/capture.mjs
npm run encode && node scripts/chatlog.mjs <openedAt ms> && node scripts/events.mjs
npm run studio                      # preview
npm run draft                       # half-scale draft
npm run render4k && npm run finish  # master, loudness to -14 LUFS
```
