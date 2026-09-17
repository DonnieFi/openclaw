// Real Gateway admission proof for public completion announces: same-key
// in_flight is not credited delivered, retained handoff rejoins instead of
// steering into a successor, and terminal settlement releases registry custody.
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  buildAnnounceIdFromChildRun,
  buildAnnounceIdempotencyKey,
} from "../agents/announce-idempotency.js";
import type { AgentCommandOpts } from "../agents/command/types.js";
import { createTaskCompletionEvent } from "../agents/subagent-test-fixtures.test-helpers.js";
import {
  clearRetainedCompletionHandoffKeysForTest,
  shouldJoinOriginalCompletionHandoff,
} from "../agents/subagents/announce/subagent-announce-completion-handoff-retention.js";
import {
  deliverSubagentAnnouncement,
  testing as announceTesting,
} from "../agents/subagents/announce/subagent-announce-delivery.test-support.js";
import {
  getSubagentRunByRunId,
  initSubagentRegistry,
  registerSubagentRun,
} from "../agents/subagents/registry/subagent-registry.js";
import {
  settleSubagentRegistryPersistenceWork,
  writeSubagentSessionEntry,
} from "../agents/subagents/registry/subagent-registry.persistence.test-support.js";
import { loadSubagentRegistryFromSqlite } from "../agents/subagents/registry/subagent-registry.store.sqlite.js";
import { resetSubagentRegistryForTests } from "../agents/subagents/registry/subagent-registry.test-helpers.js";
import { dispatchGatewayMethodInProcess } from "./server-plugin-in-process-dispatch.js";
import { startGatewayServerHarness, type GatewayServerHarness } from "./server.e2e-ws-harness.js";
import {
  agentCommandMock,
  installGatewayTestHooks,
  prepareGatewayReplyRuntimeForTest,
  testState,
  writeSessionStore,
} from "./test-helpers.js";

describe("public completion handoff real Gateway admission", () => {
  let harness: GatewayServerHarness;
  let kernel: Awaited<ReturnType<(typeof import("./server-kernel.js"))["createGatewayKernel"]>>;
  let sequence = 0;
  let requesterSessionKey: string;
  let requesterSessionId: string;
  let childSessionKey: string;
  let childRunId: string;
  let handoffKey: string;
  let storePath: string;
  let steer: ReturnType<typeof vi.fn>;

  async function start() {
    const module = await import("./server-kernel.js");
    const create = module.createGatewayKernel;
    const capture = vi.spyOn(module, "createGatewayKernel").mockImplementation(async (...args) => {
      kernel = await create(...args);
      return kernel;
    });
    try {
      harness = await startGatewayServerHarness();
    } finally {
      capture.mockRestore();
    }
  }

  installGatewayTestHooks({ scope: "suite", setup: start, cleanup: async () => harness?.close() });

  function installAnnounceDeps(params?: {
    requesterSessionActivity?: () => {
      sessionId?: string;
      runId?: string;
      isActive: boolean;
    };
  }) {
    announceTesting.setDepsForTest({
      getRequesterSessionActivity:
        params?.requesterSessionActivity ??
        (() => ({
          sessionId: requesterSessionId,
          isActive: false,
        })),
      getRuntimeConfig: () => ({}) as never,
      sendMessage: vi.fn(async () => ({
        channel: "slack",
        to: "channel:C-handoff",
        via: "direct" as const,
        mediaUrl: null,
        result: { messageId: "msg-handoff" },
      })) as never,
      queueEmbeddedAgentMessageWithOutcome: steer,
    });
  }

  beforeEach(async () => {
    sequence += 1;
    requesterSessionKey = `agent:main:slack:channel:C-handoff-${sequence}`;
    requesterSessionId = `requester-session-handoff-${sequence}`;
    childRunId = `child-handoff-${sequence}`;
    childSessionKey = `agent:main:subagent:${childRunId}`;
    handoffKey = buildAnnounceIdempotencyKey(
      buildAnnounceIdFromChildRun({ childSessionKey, childRunId }),
    );
    storePath = path.join(
      process.env.OPENCLAW_STATE_DIR!,
      "agents",
      "main",
      "sessions",
      "sessions.json",
    );
    testState.sessionStorePath = storePath;
    await writeSessionStore({
      entries: {
        [requesterSessionKey]: { sessionId: requesterSessionId, updatedAt: Date.now() },
      },
    });
    await writeSubagentSessionEntry({
      stateDir: process.env.OPENCLAW_STATE_DIR!,
      agentId: "main",
      sessionKey: childSessionKey,
      defaultSessionId: `${childRunId}-session`,
    });
    clearRetainedCompletionHandoffKeysForTest();
    steer = vi.fn(async () => ({
      queued: true as const,
      enqueuedAtMs: Date.now(),
      deliveredAtMs: Date.now(),
    }));
    installAnnounceDeps();
    agentCommandMock.mockReset();
    await prepareGatewayReplyRuntimeForTest();
  });

  afterEach(() => {
    announceTesting.setDepsForTest();
    clearRetainedCompletionHandoffKeysForTest();
  });

  function agentParams(message: string) {
    return {
      sessionKey: requesterSessionKey,
      message,
      deliver: true,
      bestEffortDeliver: true,
      idempotencyKey: handoffKey,
      inputProvenance: {
        kind: "inter_session",
        sourceTool: "subagent_announce",
        sourceSessionKey: childSessionKey,
      },
    };
  }

  function announce() {
    return deliverSubagentAnnouncement({
      requesterSessionKey,
      targetRequesterSessionKey: requesterSessionKey,
      triggerMessage: "child done",
      steerMessage: "child done",
      requesterSessionOrigin: {
        channel: "slack",
        to: "channel:C-handoff",
        accountId: "acct-1",
      },
      completionDirectOrigin: {
        channel: "slack",
        to: "channel:C-handoff",
        accountId: "acct-1",
      },
      directOrigin: {
        channel: "slack",
        to: "channel:C-handoff",
        accountId: "acct-1",
      },
      requesterIsSubagent: false,
      expectsCompletionMessage: true,
      bestEffortDeliver: true,
      directIdempotencyKey: handoffKey,
      sourceRunId: childRunId,
      sourceSessionKey: childSessionKey,
      sourceTool: "sessions_spawn",
      internalEvents: [
        createTaskCompletionEvent({
          childSessionKey,
          childSessionId: `${childRunId}-session`,
          taskLabel: "handoff proof",
          status: "ok",
          result: "The delegated task is complete.",
        }),
      ],
      resolveGatewayContext: () => kernel.gatewayRequestContext,
    });
  }

  it(
    "keeps same-key in_flight undelivered, rejoins under successor activity, and settles registry",
    { timeout: 30_000 },
    async () => {
      const held = createDeferred();
      const release = createDeferred();
      agentCommandMock.mockImplementationOnce(async (input) => {
        const command = input as AgentCommandOpts;
        command.onExecutionStarted?.();
        held.resolve();
        await release.promise;
        return {
          payloads: [{ text: "The delegated task is complete." }],
          meta: { durationMs: 1 },
          deliverySucceeded: true,
          deliveryStatus: {
            requested: true,
            attempted: true,
            status: "sent",
            succeeded: true,
            resultCount: 1,
          },
        };
      });

      registerSubagentRun({
        runId: childRunId,
        childSessionKey,
        requesterSessionKey,
        requesterDisplayKey: requesterSessionKey,
        task: "handoff proof",
        cleanup: "keep",
        expectsCompletionMessage: true,
        spawnMode: "run",
      });
      await settleSubagentRegistryPersistenceWork();
      expect(getSubagentRunByRunId(childRunId)?.runId).toBe(childRunId);

      const original = dispatchGatewayMethodInProcess<Record<string, unknown>>(
        "agent",
        agentParams("original completion handoff"),
        {
          expectFinal: true,
          forceSyntheticClient: true,
          operatorRoleActor: { kind: "system" },
          resolveGatewayContext: () => kernel.gatewayRequestContext,
        },
      );
      await held.promise;

      const pending = await announce();
      expect(pending).toMatchObject({
        delivered: false,
        path: "direct",
        reason: "completion_handoff_pending",
        disposition: "retryable",
        terminal: true,
      });
      expect(shouldJoinOriginalCompletionHandoff(handoffKey)).toBe(true);

      installAnnounceDeps({
        requesterSessionActivity: () => ({
          sessionId: requesterSessionId,
          runId: "successor-requester-run",
          isActive: true,
        }),
      });
      const rejoined = await announce();
      expect(rejoined).toMatchObject({
        delivered: false,
        path: "direct",
        reason: "completion_handoff_pending",
        disposition: "retryable",
        terminal: true,
      });
      expect(steer).not.toHaveBeenCalled();
      expect(shouldJoinOriginalCompletionHandoff(handoffKey)).toBe(true);

      release.resolve();
      const terminal = await original;
      expect(terminal).toMatchObject({ runId: handoffKey, status: "ok" });

      const settled = await announce();
      expect(settled).toMatchObject({
        delivered: true,
        path: "direct",
      });
      expect(steer).not.toHaveBeenCalled();
      expect(shouldJoinOriginalCompletionHandoff(handoffKey)).toBe(false);

      await settleSubagentRegistryPersistenceWork();
      expect(getSubagentRunByRunId(childRunId)?.runId).toBe(childRunId);
      expect(loadSubagentRegistryFromSqlite().get(childRunId)?.runId).toBe(childRunId);

      resetSubagentRegistryForTests({ persist: false });
      initSubagentRegistry();
      expect(getSubagentRunByRunId(childRunId)?.runId).toBe(childRunId);
      expect(loadSubagentRegistryFromSqlite().get(childRunId)?.runId).toBe(childRunId);
    },
  );
});
