/**
 * Requester-agent handoff and direct delivery for subagent announcements.
 */
import {
  clearRetainedCompletionHandoffKeysForTest,
  settleCompletionHandoffRetention,
} from "./subagent-announce-completion-handoff-retention.js";
import { sendSubagentAnnounceDirectlyImpl } from "./subagent-announce-direct-delivery-impl.js";
import type { SubagentAnnounceDeliveryResult } from "./subagent-announce-dispatch.js";

export { clearRetainedCompletionHandoffKeysForTest };

export async function sendSubagentAnnounceDirectly(
  params: Parameters<typeof sendSubagentAnnounceDirectlyImpl>[0],
): Promise<SubagentAnnounceDeliveryResult> {
  return settleCompletionHandoffRetention(
    params.directIdempotencyKey,
    await sendSubagentAnnounceDirectlyImpl(params),
  );
}
