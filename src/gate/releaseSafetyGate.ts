import { PatchVerificationResult } from '../services/checkoutTarget.js';

export interface ReleaseApprovalAttempt {
  senderParticipantId: string;
  senderName: string;
  messageBody: string;
  activeIncidentId: string;
  knownAgentParticipantIds: Set<string>;
  knownAgentNames: Set<string>;
  patchVerification: PatchVerificationResult | null;
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
          policy.allowedApprovers = /^(any|any-human|anyone|\*)$/i.test(value) ? ['any-human'] : list();
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
  public static renderPolicyDocument(policy: ReleasePolicy, changedBy?: string): string {
    return [
      '# Production Release Gate Policy',
      '- **Invariant 1 (Human Sign-off):** Only `@switch-user-*` human participants may authorize `promote` or `rollback`. Agent self-approvals are rejected.',
      '- **Invariant 2 (Incident Binding):** Approval message must cite the active `INC-XXXX` identifier.',
      '- **Invariant 3 (Verified Artifact):** `promote` requires green reproduction + regression suite; `rollback` to `v2.13.2` is always available.',
      '- **Invariant 4 (Synthetic Canary):** Post-deploy synthetic checkout probes must return `200 OK` before closing the incident.',
      '- **Invariant 5 (Blast Radius):** Candidate diffs are capped and may not touch protected paths.',
      '',
      '## Enforced Parameters',
      'Edited from chat by verified humans only (e.g. `@vigil-release-gate set max diff 60`). Re-read by the gate on every evaluation.',
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
        : raw.split(/[,\s]+/).map((x) => x.replace(/^@/, '').toLowerCase()).filter(Boolean);
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
    // Bare handle inside the participant id, e.g. `@switch-user-vigil-patcher:switch.local` -> `vigil-patcher`
    const senderHandle = lowerSenderId.match(/^@switch-(?:user|agent)-([^:\s]+)/)?.[1] ?? '';
    // Display name with any trailing qualifier stripped, e.g. `vigil-patcher (Rogue Agent Test)` -> `vigil-patcher`
    const senderNameStem = lowerSenderName.replace(/\s*[([].*$/, '').trim();
    const isAgentSender =
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
      const handle = (lowerSenderId.match(/^@switch-user-([^:\s]+)/)?.[1] ?? senderNameStem).toLowerCase();
      const permitted = policy.allowedApprovers.some(
        (a) => a === handle || a === lowerSenderName || a === senderNameStem,
      );
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
        explanation: `Human operator '${attempt.senderName}' authorized immediate rollback of ${parsed.incidentId} to last-known-good v2.13.2.`,
      };
    }

    // Invariant 4: Promoting a hotfix requires confirmed reproduction + 100% green test matrix
    const v = attempt.patchVerification;
    if (!v || !v.reproConfirmed || (policy.requireGreenMatrix && !v.allPassed)) {
      return {
        allowed: false,
        action: 'promote',
        incidentIdCited: parsed.incidentId,
        reasonCode: 'REJECTED_UNVERIFIED_PATCH',
        explanation: `Cannot promote candidate patch for ${parsed.incidentId}: reproduction or regression verification matrix is incomplete/failing. Use \`rollback\` if immediate mitigation is needed.`,
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
      explanation: `Human operator '${attempt.senderName}' approved verified hotfix ${v.candidateVersion} authored by ${v.author} (${v.changedLines} lines, ${v.testMatrix.length}/${v.testMatrix.length} green checks, policy max ${policy.maxChangedLines}) for ${parsed.incidentId}.`,
    };
  }
}
