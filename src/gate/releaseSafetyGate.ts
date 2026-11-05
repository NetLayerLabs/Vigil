import { PatchVerificationResult } from '../services/checkoutSandbox.js';

export interface ReleaseApprovalAttempt {
  senderParticipantId: string;
  senderName: string;
  messageBody: string;
  activeIncidentId: string;
  knownAgentParticipantIds: Set<string>;
  knownAgentNames: Set<string>;
  patchVerification: PatchVerificationResult | null;
}

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
    | 'REJECTED_DIFF_POLICY_VIOLATION';
  explanation: string;
}

const FORBIDDEN_PATH_PATTERNS = [/\.env/i, /secret/i, /auth-keys/i, /migrations\/drop/i];
const MAX_ALLOWED_PATCH_LINES = 40;

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

  public static evaluate(attempt: ReleaseApprovalAttempt): ReleaseGateDecision {
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
    if (!v || !v.reproConfirmed || !v.allPassed) {
      return {
        allowed: false,
        action: 'promote',
        incidentIdCited: parsed.incidentId,
        reasonCode: 'REJECTED_UNVERIFIED_PATCH',
        explanation: `Cannot promote candidate patch for ${parsed.incidentId}: reproduction or regression verification matrix is incomplete/failing. Use \`rollback\` if immediate mitigation is needed.`,
      };
    }

    // Invariant 5: Blast-radius diff cap & forbidden file guard
    if (
      v.changedLines > MAX_ALLOWED_PATCH_LINES ||
      v.touchedFiles.some((f) => FORBIDDEN_PATH_PATTERNS.some((rx) => rx.test(f)))
    ) {
      return {
        allowed: false,
        action: 'promote',
        incidentIdCited: parsed.incidentId,
        reasonCode: 'REJECTED_DIFF_POLICY_VIOLATION',
        explanation: `Candidate patch violates hotfix policy (changedLines=${v.changedLines}, max=${MAX_ALLOWED_PATCH_LINES}, files=${v.touchedFiles.join(', ')}).`,
      };
    }

    return {
      allowed: true,
      action: 'promote',
      incidentIdCited: parsed.incidentId,
      reasonCode: 'APPROVED_PROMOTE',
      explanation: `Human operator '${attempt.senderName}' approved verified hotfix ${v.candidateVersion} (${v.changedLines} lines, ${v.testMatrix.length}/${v.testMatrix.length} green checks) for ${parsed.incidentId}.`,
    };
  }
}
