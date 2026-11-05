# #HowISwitch social set for Vigil

## A. X / Twitter thread (each post under 280 characters)

**1/**
Your coding agent fixes bugs in a terminal nobody else can see. During a SEV-1 that is a liability, not a feature. For the Flip the Switch Hackathon we put the agent inside the incident room with the humans. Meet Vigil. #HowISwitch

**2/**
Switch turns every chat channel into a room: shared log, roles, documents, links. Vigil's YAML template creates three linked rooms, #incidents -> #hotfix -> #releases, with exclusive roles for incident-commander, patch-author and release-gatekeeper.

**3/**
Claude Code is the patch author, bound through Switch Console. It reproduces the fault, writes the fix, and hands the diff to Vigil's verifier in chat. The verifier runs the regression matrix. A diff that does not carry the fix is rejected and never reaches the release room.

**4/**
Release policy is not in code. It lives in a Switch room document. Priya types "set max diff 1" and the next approval is rejected for blast radius (even a two-line fix). "set approvers sam" and her own approval is refused. An agent trying the same command is blocked.

**5/**
Kill the incident commander mid-incident. A standby reopens the same connection_id from the last cursor. The wedged socket gets evicted: taken_over, the new generation resumes with no gap, and the exclusive lease is re-asserted. The incident still closes.

**6/**
Each incident gets its own ephemeral workroom, created from a template, linked from #hotfix, archived at closure. Rooms as lifecycle objects, not static channels.

**7/**
Nothing ships without a human. The gate deterministically rejects agent self-approvals, then a teammate replies "approve INC-2041 promote" in Mattermost. Five synthetic canary probes, a postmortem document, lease released.

**8/**
Clone, npm test, npm start, click Launch App. Built for @WeMakeDevs_ and @<switch-handle> Track 01.
https://github.com/mrnetwork0001/Vigil #HowISwitch

## B. LinkedIn post

Most teams that adopted a coding agent have the same gap: the agent is excellent in one engineer's terminal and invisible to everyone else. During a production incident that gap becomes risk. Nobody can see the fix being made, nobody holds command, and an agent with deploy credentials can approve its own release.

For the Flip the Switch Hackathon by WeMakeDevs and Switch AI, we built Vigil to close that gap. Switch turns chat channels into rooms with shared logs, exclusive roles, documents and links. Vigil maps an incident onto three linked rooms: triage, hotfix, release.

What makes it different: Claude Code writes the fix inside the room and Vigil's verifier rejects any diff that does not actually carry it. Release policy lives in a Switch room document and is edited from chat, by humans only. The incident commander can crash mid-incident and a standby takes over the same connection without losing the lease. Each incident gets its own workroom, created from a template and archived at closure.

Nothing reaches production without a human typing approve. Repo and 30-second setup in the comments. #HowISwitch

## C. 20-second screen recording shot list

1. (0 to 4s) Landing page, click Launch App. The three linked rooms appear on the left with idle leases.
2. (4 to 8s) Click "1. JPY Zero-Decimal 500". Watch the sentinel claim incident-commander and the escalation land in #vigil-hotfix.
3. (8 to 12s) Patch tab: paste the diff into the external intake and submit. The verifier posts the green matrix and hands off to #vigil-releases.
4. (12 to 16s) Chat bar: send "set max diff 1" then "approve INC-2041 promote". The gate rejects for blast radius; send "set max diff 60" and approve again.
5. (16 to 20s) Canary 5/5, postmortem document appears, the hotfix-inc-2041 workroom flips to archived, the lease is released.
