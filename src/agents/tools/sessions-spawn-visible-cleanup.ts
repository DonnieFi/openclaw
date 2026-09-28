import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { isSessionLifecycleChangedGatewayError } from "../subagents/registry/subagent-session-cleanup.js";
import type { InProcessGatewayCaller } from "./in-process-gateway.js";

const log = createSubsystemLogger("agents/sessions");

export function summarizeVisibleSessionSpawnError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return isRecord(error) && typeof error.message === "string" ? error.message : "error";
}

const CLEANUP_UNCONFIRMED =
  "Session cleanup unconfirmed. Inspect the child session before retrying.";

/**
 * Archive-then-delete is the operator.write deletion contract, so a spawn
 * running under write-only operator authority can still roll back its child.
 */
export async function cleanupVisibleSpawnSession(params: {
  callGateway: InProcessGatewayCaller;
  childSessionKey: string;
  expectedSessionId?: string;
  expectedLifecycleRevision?: string;
}): Promise<string> {
  const {
    callGateway,
    childSessionKey: key,
    expectedSessionId,
    expectedLifecycleRevision,
  } = params;
  if (!expectedSessionId || !expectedLifecycleRevision) {
    return CLEANUP_UNCONFIRMED;
  }
  let archived = false;
  try {
    await callGateway("sessions.patch", {
      key,
      archived: true,
      expectedSessionId,
      expectedLifecycleRevision,
    });
    archived = true;
    await callGateway("sessions.delete", {
      key,
      deleteTranscript: true,
      expectedSessionId,
      archivedOnly: true,
    });
    return "Session removed.";
  } catch (error) {
    if (isSessionLifecycleChangedGatewayError(error)) {
      return "Session changed; newer session kept.";
    }
    log.warn(`visible session cleanup failed: ${formatErrorMessage(error)}`);
    return archived
      ? "Session archived but not deleted. Inspect the archived child session before retrying."
      : CLEANUP_UNCONFIRMED;
  }
}
