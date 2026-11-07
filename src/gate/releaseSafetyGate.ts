import { PatchVerificationResult } from '../services/checkoutTarget.js';

export interface ReleaseApprovalAttempt {
  senderParticipantId: string;
  senderName: string;
  /** Who the server says sent it: `user` (a human on a bridge), `agent` or `platform`. Absent on the embedded server. */
  senderKind?: string | null;
  messageBody: string;
  activeIncidentId: string;
  knownAgentParticipantIds: Set<string>;
  knownAgentNames: Set<string>;
  patchVerification: PatchVerificationResult | null;
  /** The release a rollback returns to (from the incident's alert). */
  lastKnownGoodVersion?: string;
  /** Policy read from the `release-safety-policy` Switch room document at evaluation time. */
  policy?: ReleasePolicy;
}

/**
 * Release policy parameters. The source of truth is the `release-safety-policy` room-scoped
 * document in `#{team}-releases`; humans change it from chat and the gate re-reads it on every
 * evaluation, so governance lives in the Switch room rather than in code.
 */
export interface ReleasePolicy {
  maxChangedLines: number;
  forbiddenPaths: string[];
  requireGreenMatrix: boolean;
  /** `['any-human']` or a list of lower-case human handles permitted to approve. */
  allowedApprovers: string[];
  minCanaryProbes: number;
}

export const DEFAULT_RELEASE_POLICY: ReleasePolicy = {
  maxChangedLines: 40,
  forbiddenPaths: ['.env', 'secret', 'auth-keys', 'migrations/drop'],
  requireGreenMatrix: true,
  allowedApprovers: ['any-human'],
  minCanaryProbes: 5,
};

export interface ReleaseGateDecision {
  allowed: boolean;
  action: 'promote' | 'rollback' | null;
  incidentIdCited: string | null;
  reasonCode:
    | 'APPROVED_PROMOTE'
    | 'APPROVED_ROLLBACK'
    | 'REJECTED_AGENT_SENDER'
    | 'REJECTED_UNRECOGNIZED_COMMAND'
    | 'REJECTED_INCIDENT_MISMATCH'
    | 'REJECTED_UNVERIFIED_PATCH'
    | 'REJECTED_DIFF_POLICY_VIOLATION'
    | 'REJECTED_UNAUTHORIZED_APPROVER';
  explanation: string;
}

export interface PolicyChangeCommand {
  field: keyof ReleasePolicy;
  value: ReleasePolicy[keyof ReleasePolicy];
  summary: string;
}

/**
 * Deterministic Zero-LLM Production Release Safety Gate
 *
 * Enforces hard architectural invariants on every chat message in `#vigil-releases`
 * before any deployment or rollback can touch `checkout-api`.
 */
export class ReleaseSafetyGate {
  public static parseCommand(body: string): {
    incidentId: string | null;
    action: 'promote' | 'rollback' | null;
  } {
    const normalized = body.trim();
    const match = normalized.match(
      /\b(?:approve|ship|execute)\s+(INC-[0-9A-Z-]+)\s+(promote|canary|rollback)\b/i,
    );
    if (match) {
      const rawAction = match[2].toLowerCase();
      return {
        incidentId: match[1].toUpperCase(),
        action: rawAction === 'rollback' ? 'rollback' : 'promote',
      };
    }

    const rollbackShorthand = normalized.match(/\brollback\s+(INC-[0-9A-Z-]+)\b/i);
    if (rollbackShorthand) {
      return {
        incidentId: rollbackShorthand[1].toUpperCase(),
        action: 'rollback',
      };
    }

    return { incidentId: null, action: null };
  }

  /**
   * Parse the machine-readable `## Enforced Parameters` block of the `release-safety-policy` room
   * document. Unknown or malformed lines fall back to defaults, so a hand-edited doc degrades safely.
   */
  public static parsePolicyDocument(content: string | null | undefined): ReleasePolicy {
    const policy: ReleasePolicy = {
      ...DEFAULT_RELEASE_POLICY,
      forbiddenPaths: [...DEFAULT_RELEASE_POLICY.forbiddenPaths],
      allowedApprovers: [...DEFAULT_RELEASE_POLICY.allowedApprovers],
    };
    if (!content) return policy;
    const kv = /^\s*(?:[-*]\s*)?`?([a-z_]+)`?\s*[:=]\s*(.+?)\s*$/i;
    for (const rawLine of content.split('\n')) {
      const m = rawLine.match(kv);
      if (!m) continue;
      const key = m[1].toLowerCase();
      const value = m[2].replace(/`/g, '').trim();
      const list = () =>
        value
          .split(/[,\s]+/)
          .map((x) => x.trim().toLowerCase())
          .filter(Boolean);
      switch (key) {
        case 'max_changed_lines': {
          const n = Number(value);
          if (Number.isFinite(n) && n > 0) policy.maxChangedLines = Math.floor(n);
          break;
        }
        case 'forbidden_paths':
          policy.forbiddenPaths = value.toLowerCase() === 'none' ? [] : list();
          break;
        case 'require_green_matrix':
          policy.requireGreenMatrix = !/^(false|no|0|off)$/i.test(value);
          break;
        case 'allowed_approvers':
          policy.allowedApprovers = /^(any|any-human|anyone|\*)$/i.test(value) ? ['any-human'] : list().filter(ReleaseSafetyGate.isPlainHandle);
          break;
        case 'min_canary_probes': {
          const n = Number(value);
          if (Number.isFinite(n) && n >= 0) policy.minCanaryProbes = Math.floor(n);
          break;
        }
      }
    }
    return policy;
  }

  /** Render the human-readable + machine-readable policy document body. */
  /**
   * Who the gate @-mentions when a fix needs a decision: the approvers named in the policy, so whoever is
   * on call is pinged; the release owner when any person may approve. Only plain chat handles are used, and
   * never a channel-wide mention (@all, @channel, @here), so a policy edit cannot page a whole room.
   */
  public static approverMentions(policy: ReleasePolicy, owner: string, agentNames: Iterable<string> = []): string {
    const agents = new Set([...agentNames].map((a) => a.toLowerCase()));
    const handles = policy.allowedApprovers.includes('any-human')
      ? []
      : policy.allowedApprovers.filter((h) => ReleaseSafetyGate.isPlainHandle(h) && !agents.has(h.toLowerCase())).slice(0, 10);
    return (handles.length ? handles : [owner]).map((h) => `@${h}`).join(' ');
  }

  /**
   * A chat username that is safe to @-mention: letters, digits, '.', '_' or '-', starting and ending with a
   * letter or digit. Mattermost strips trailing '.', '-', ':' and '_' before matching special mentions, so
   * requiring an alphanumeric last character (plus the explicit list) keeps @all, @channel, @here and
   * @everyone, in any disguise, out of the gate's messages.
   */
  public static isPlainHandle(h: string): boolean {
    if (!/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/i.test(h)) return false;
    return !['all', 'channel', 'here', 'everyone'].includes(h.toLowerCase().replace(/[._-]+$/, ''));
  }

  /** A name from an author or a sender, shown in the gate's messages: plain text only, else the fallback. */
  public static safeName(name: string | undefined | null, fallback: string): string {
    const n = (name ?? '').trim();
    return /^[a-z0-9][a-z0-9._ -]{0,63}$/i.test(n) ? n : fallback;
  }

  /**
   * Text from outside Vigil (a service response, an alert) inside a chat message: one line, no backticks,
   * inside a code span, with '@' defused (zero-width space), so it cannot format the message, address an
   * agent or page anyone, whichever reader (Mattermost or Switch's addressing) sees it.
   */
  public static quoteUntrusted(text: string, max = 160): string {
    const clean = String(text).replace(/[`\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max).replace(/@/g, '@\u200b');
    return `\`${clean}\``;
  }

  /**
   * The reproduced evidence for the person who approves, from Vigil's own checks rather than the author's
   * summary: the failure as the patcher reproduced it on the live service, and the same request replayed on
   * the candidate on staging.
   */
  public static describeEvidence(v: PatchVerificationResult | null | undefined, liveVersion: string): string[] {
    if (!v) return [];
    const lines: string[] = [];
    // Response text comes from the service and the candidate, the version from the alert: quoted, so it can
    // never format the message, address an agent or @-mention anyone.
    const quote = (text: string) => ReleaseSafetyGate.quoteUntrusted(text);
    if (v.reproConfirmed && v.reproErrorOutput) {
      lines.push(`- Before, on live ${quote(liveVersion)}: ${quote(v.reproErrorOutput)}`);
    }
    let replay = v.stagingReplay;
    if (replay === undefined) {
      // Records written before stagingReplay existed: read it back from the staging check's detail.
      const row = v.testMatrix.find((t) => /staging probe/.test(t.name));
      const m = row?.detail.match(/HTTP (\d{3})(?: charge=(\d+))?/);
      replay = m ? { httpStatus: Number(m[1]), ...(m[2] ? { chargeMinorUnits: Number(m[2]) } : {}) } : null;
    }
    if (replay) {
      const status = Number.isInteger(replay.httpStatus) ? replay.httpStatus : 0;
      const charge = typeof replay.chargeMinorUnits === 'number' && Number.isFinite(replay.chargeMinorUnits) ? replay.chargeMinorUnits : undefined;
      const result = status === 0
        ? `no response${replay.error ? ` ${quote(replay.error)}` : ''}`
        : charge !== undefined
          ? `HTTP ${status}, charge ${charge} (minor units)`
          : `HTTP ${status}${replay.error ? ` ${quote(replay.error)}` : ''}`;
      lines.push(`- After, the same request on staging with the fix: ${result}`);
    }
    return lines;
  }

  public static renderPolicyDocument(policy: ReleasePolicy, changedBy?: string, team = 'vigil'): string {
    return [
      '# Release policy',
      'The release gate checks these rules on every approval. It is plain code; no model decides.',
      '',
      '- Only a person can approve. Approvals from agents are refused.',
      '- The approval names the open incident, for example `approve INC-2041 promote`.',
      '- Shipping needs the reproduction and the tests to pass. Rolling back to the last good release is always allowed.',
      '- After a deploy, every canary probe must answer 200 before the incident closes.',
      '- A fix may change only so many lines, and never touch the protected paths below.',
      '',
      '## Settings',
      `People change these from chat, for example \`@${team}-release-gate set max diff 60\`. The gate reads them again on every approval.`,
      `- max_changed_lines: ${policy.maxChangedLines}`,
      `- forbidden_paths: ${policy.forbiddenPaths.length ? policy.forbiddenPaths.join(', ') : 'none'}`,
      `- require_green_matrix: ${policy.requireGreenMatrix}`,
      `- allowed_approvers: ${policy.allowedApprovers.join(', ')}`,
      `- min_canary_probes: ${policy.minCanaryProbes}`,
      '',
      changedBy ? `_Last changed by ${changedBy} at ${new Date().toISOString()}_` : '',
    ]
      .join('\n')
      .trimEnd();
  }

  /**
   * Parse a chat policy-change command. Grammar (case-insensitive):
   *   set max diff 60 | set max_changed_lines 60
   *   set approvers priya,sam | set approvers any
   *   set forbidden paths .env,secret | set forbidden paths none
   *   set green matrix on|off
   *   set canary probes 3
   */
  public static parsePolicyCommand(body: string): PolicyChangeCommand | null {
    const text = body.replace(/\s+/g, ' ').trim();
    let m = text.match(/\bset\s+(?:max[\s_-]?(?:diff|changed[\s_-]?lines)|diff[\s_-]?cap)\s+(?:to\s+)?(\d{1,4})\b/i);
    if (m) {
      const n = Number(m[1]);
      return { field: 'maxChangedLines', value: n, summary: `max_changed_lines -> ${n}` };
    }
    m = text.match(/\bset\s+(?:allowed[\s_-]?)?approvers?\s+(?:to\s+)?([a-z0-9_,.\- ]+?)(?:\s*$|\s+(?:please|now)\b)/i);
    if (m) {
      const raw = m[1].trim();
      const value = /^(any|anyone|any-human|\*)$/i.test(raw)
        ? ['any-human']
        : raw.split(/[,\s]+/).map((x) => x.replace(/^@/, '').toLowerCase()).filter(ReleaseSafetyGate.isPlainHandle);
      if (!value.length) return null;
      return { field: 'allowedApprovers', value, summary: `allowed_approvers -> ${value.join(', ')}` };
    }
    m = text.match(/\bset\s+forbidden[\s_-]?paths?\s+(?:to\s+)?([^\s].*?)\s*$/i);
    if (m) {
      const raw = m[1].trim();
      const value = /^none$/i.test(raw) ? [] : raw.split(/[,\s]+/).map((x) => x.toLowerCase()).filter(Boolean);
      return { field: 'forbiddenPaths', value, summary: `forbidden_paths -> ${value.length ? value.join(', ') : 'none'}` };
    }
    m = text.match(/\bset\s+(?:require[\s_-]?)?green[\s_-]?matrix\s+(on|off|true|false|required|optional)\b/i);
    if (m) {
      const value = /^(on|true|required)$/i.test(m[1]);
      return { field: 'requireGreenMatrix', value, summary: `require_green_matrix -> ${value}` };
    }
    m = text.match(/\bset\s+(?:min[\s_-]?)?canary[\s_-]?probes?\s+(?:to\s+)?(\d{1,2})\b/i);
    if (m) {
      const n = Number(m[1]);
      return { field: 'minCanaryProbes', value: n, summary: `min_canary_probes -> ${n}` };
    }
    return null;
  }

  public static applyPolicyCommand(policy: ReleasePolicy, cmd: PolicyChangeCommand): ReleasePolicy {
    return { ...policy, [cmd.field]: cmd.value } as ReleasePolicy;
  }

  public static evaluate(attempt: ReleaseApprovalAttempt): ReleaseGateDecision {
    const policy = attempt.policy ?? DEFAULT_RELEASE_POLICY;
    // Invariant 1: Block AI agent self-approvals & prompt-injected agent senders!
    const lowerSenderId = attempt.senderParticipantId.toLowerCase();
    const lowerSenderName = attempt.senderName.toLowerCase();
    // Handle inside the participant id: `@switch-user-priya:switch.local` (embedded server) or
    // `@switch-mattermost-<bridge uuid>-priya:localhost` (a person on a real server's chat bridge).
    const senderHandle = handleFromParticipantId(lowerSenderId);
    // Display name with any trailing qualifier stripped, e.g. `vigil-patcher (Rogue Agent Test)` -> `vigil-patcher`
    const senderNameStem = lowerSenderName.replace(/\s*[([].*$/, '').trim();
    // Fail closed: without the server saying `user`, only participant ids of people count as people.
    const looksHuman = attempt.senderKind === 'user' || (attempt.senderKind == null && HUMAN_PARTICIPANT.test(lowerSenderId));
    const isAgentSender =
      // The server's own word wins: anything it does not mark as a human user cannot approve.
      (attempt.senderKind != null && attempt.senderKind !== 'user') ||
      !looksHuman ||
      lowerSenderId.startsWith('@switch-agent-') ||
      attempt.knownAgentParticipantIds.has(attempt.senderParticipantId) ||
      attempt.knownAgentNames.has(lowerSenderName) ||
      attempt.knownAgentNames.has(senderNameStem) ||
      (senderHandle !== '' && attempt.knownAgentNames.has(senderHandle));

    if (isAgentSender) {
      return {
        allowed: false,
        action: null,
        incidentIdCited: null,
        reasonCode: 'REJECTED_AGENT_SENDER',
        explanation: `Blocked autonomous self-approval from agent participant '${attempt.senderName}' (${attempt.senderParticipantId}). Production changes require a verified human teammate.`,
      };
    }

    // Invariant 2: Parse explicit command grammar
    const parsed = this.parseCommand(attempt.messageBody);
    if (!parsed.action || !parsed.incidentId) {
      return {
        allowed: false,
        action: null,
        incidentIdCited: null,
        reasonCode: 'REJECTED_UNRECOGNIZED_COMMAND',
        explanation: `Awaiting explicit human release decision: reply \`@${'vigil-release-gate'} approve ${attempt.activeIncidentId} promote\` or \`@${'vigil-release-gate'} approve ${attempt.activeIncidentId} rollback\`.`,
      };
    }

    // Invariant 3: Incident ID must match currently active incident
    if (parsed.incidentId !== attempt.activeIncidentId.toUpperCase()) {
      return {
        allowed: false,
        action: parsed.action,
        incidentIdCited: parsed.incidentId,
        reasonCode: 'REJECTED_INCIDENT_MISMATCH',
        explanation: `Approval cited '${parsed.incidentId}', which does not match active incident '${attempt.activeIncidentId}'.`,
      };
    }

    // Invariant 3b: Approver allow-list from the room-document policy (`allowed_approvers`)
    if (!policy.allowedApprovers.includes('any-human')) {
      // Match the chat handle in the participant id when there is one: a display name can be changed.
      const permitted = senderHandle
        ? policy.allowedApprovers.includes(senderHandle)
        : policy.allowedApprovers.some((a) => a === lowerSenderName || a === senderNameStem);
      if (!permitted) {
        return {
          allowed: false,
          action: parsed.action,
          incidentIdCited: parsed.incidentId,
          reasonCode: 'REJECTED_UNAUTHORIZED_APPROVER',
          explanation: `'${attempt.senderName}' is not in the room policy's allowed_approvers (${policy.allowedApprovers.join(', ')}). Edit \`release-safety-policy\` or ask an authorized approver.`,
        };
      }
    }

    // Rollback to last-known-good (`v2.13.2`) is always allowed for a verified human
    if (parsed.action === 'rollback') {
      return {
        allowed: true,
        action: 'rollback',
        incidentIdCited: parsed.incidentId,
        reasonCode: 'APPROVED_ROLLBACK',
        explanation: `${attempt.senderName} approved rolling ${parsed.incidentId} back to the last good release${attempt.lastKnownGoodVersion ? ` ${attempt.lastKnownGoodVersion}` : ''}.`,
      };
    }

    // Invariant 4: Promoting needs a confirmed reproduction, a candidate commit that is still staged
    // (a failed candidate is discarded, so there is nothing to ship), and a green matrix when required.
    const v = attempt.patchVerification;
    if (!v || !v.reproConfirmed || !v.candidateSha || (policy.requireGreenMatrix && !v.allPassed)) {
      return {
        allowed: false,
        action: 'promote',
        incidentIdCited: parsed.incidentId,
        reasonCode: 'REJECTED_UNVERIFIED_PATCH',
        explanation: `There is no verified fix to ship for ${parsed.incidentId}: ${!v ? 'nothing has been staged yet' : !v.reproConfirmed ? 'the failure was not reproduced' : !v.candidateSha ? 'the last candidate failed its checks and was discarded' : 'its checks did not all pass'}. Use \`rollback\` to go back to the last good release.`,
      };
    }

    // Invariant 5: Blast-radius diff cap & forbidden file guard
    const forbiddenHit = v.touchedFiles.find((f) =>
      policy.forbiddenPaths.some((p) => f.toLowerCase().includes(p.toLowerCase())),
    );
    if (v.changedLines > policy.maxChangedLines || forbiddenHit) {
      return {
        allowed: false,
        action: 'promote',
        incidentIdCited: parsed.incidentId,
        reasonCode: 'REJECTED_DIFF_POLICY_VIOLATION',
        explanation: forbiddenHit
          ? `Candidate patch touches protected path '${forbiddenHit}' (room policy forbidden_paths: ${policy.forbiddenPaths.join(', ')}).`
          : `Candidate patch changes ${v.changedLines} lines; room policy max_changed_lines is ${policy.maxChangedLines}. Raise it with \`set max diff N\` or shrink the diff.`,
      };
    }

    return {
      allowed: true,
      action: 'promote',
      incidentIdCited: parsed.incidentId,
      reasonCode: 'APPROVED_PROMOTE',
      explanation: `${attempt.senderName} approved ${v.candidateVersion} by ${v.author} for ${parsed.incidentId}: ${v.changedLines} changed lines (policy max ${policy.maxChangedLines}), ${v.testMatrix.filter((t) => t.passed).length} of ${v.testMatrix.length} checks passed.`,
    };
  }
}

/** Participant ids of people: the embedded server's users, a real server's admin, and people on a chat bridge. */
const HUMAN_PARTICIPANT = /^@switch-(?:user-|admin:|admin$|(?:mattermost|slack|discord|telegram|teams)-)/;

/** The chat handle inside a participant id, or '' when the id has none. */
export function handleFromParticipantId(lowerId: string): string {
  return (
    lowerId.match(/^@switch-(?:user|agent)-([^:\s]+)/)?.[1] ??
    lowerId.match(/^@switch-[a-z]+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-([^:\s]+)/)?.[1] ??
    ''
  );
}
