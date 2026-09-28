import { expect, it, vi } from "vitest";
import type { createSessionsSpawnTool as SpawnToolFactory } from "./sessions-spawn-tool.js";

/** Visible child rollback tests share the parent suite's spawn entry point and lifecycle. */
export function registerSessionsSpawnVisibleCleanupTests({
  createTool,
}: {
  createTool: typeof SpawnToolFactory;
}) {
  it.each(["not-started", "missing-run-id", "registration"] as const)(
    "cleans up the created visible session after %s failure",
    async (failure) => {
      const callGateway = vi
        .fn()
        .mockResolvedValueOnce({
          key: "agent:main:dashboard:child",
          sessionId: "created-child",
          entry: { lifecycleRevision: "birth-revision" },
          runStarted: failure !== "not-started",
          ...(failure === "registration" ? { runId: "child-run" } : {}),
          runError: "startup failed",
        })
        .mockResolvedValueOnce({ ok: true })
        .mockResolvedValueOnce({ deleted: true });
      const registerRun = vi.fn(() => {
        throw new Error("registry unavailable");
      });
      const tool = createTool({
        agentSessionKey: "agent:main:main",
        config: { agents: { list: [{ id: "main" }] } },
        callGateway,
        registerRun,
        countActiveRuns: () => 0,
      });

      const result = await tool.execute("visible-failure", { task: "inspect", visible: true });

      expect(result.details).toMatchObject({
        status: "error",
        error: expect.stringContaining("Session removed."),
        childSessionKey: "agent:main:dashboard:child",
      });
      expect(registerRun).toHaveBeenCalledTimes(failure === "registration" ? 1 : 0);
    },
  );

  it.each([
    {
      failure: "initial child start",
      failedCleanupStep: "archive",
      runStarted: false,
      runId: undefined,
      runError: {
        code: "UNAVAILABLE",
        message: "child chat.send rejected before input admission",
      },
      registrationError: undefined,
      expectedError:
        "child chat.send rejected before input admission. Session cleanup unconfirmed. Inspect the child session before retrying.",
    },
    {
      failure: "run registration",
      failedCleanupStep: "archive",
      runStarted: true,
      runId: "child-run",
      runError: undefined,
      registrationError: "registry unavailable",
      expectedError:
        "Visible run registration failed: registry unavailable. Session cleanup unconfirmed. Inspect the child session before retrying.",
    },
    {
      failure: "initial child start",
      failedCleanupStep: "delete",
      runStarted: false,
      runId: undefined,
      runError: "startup failed",
      registrationError: undefined,
      expectedError:
        "startup failed. Session archived but not deleted. Inspect the archived child session before retrying.",
    },
  ] as const)(
    "reports the retained child when $failure and cleanup $failedCleanupStep fail",
    async (scenario) => {
      const callGateway = vi.fn().mockResolvedValueOnce({
        key: "agent:main:dashboard:child",
        sessionId: "created-child",
        entry: { lifecycleRevision: "birth-revision" },
        runStarted: scenario.runStarted,
        ...(scenario.runId ? { runId: scenario.runId } : {}),
        ...(scenario.runError ? { runError: scenario.runError } : {}),
      });
      if (scenario.failedCleanupStep === "delete") {
        callGateway.mockResolvedValueOnce({ ok: true });
      }
      callGateway.mockRejectedValueOnce(new Error("lifecycle drain unavailable"));
      const tool = createTool({
        agentSessionKey: "agent:main:main",
        config: { agents: { list: [{ id: "main" }] } },
        callGateway,
        ...(scenario.registrationError
          ? {
              registerRun: () => {
                throw new Error(scenario.registrationError);
              },
            }
          : {}),
        countActiveRuns: () => 0,
      });

      const result = await tool.execute("visible-failure", { task: "inspect", visible: true });

      expect(result.details).toMatchObject({
        status: "error",
        error: scenario.expectedError,
        childSessionKey: "agent:main:dashboard:child",
        ...(scenario.runId ? { runId: scenario.runId } : {}),
      });
    },
  );

  it.each(["sessionId", "lifecycleRevision"] as const)(
    "keeps a failed visible child when its creation receipt omits %s",
    async (missing) => {
      const callGateway = vi.fn().mockResolvedValueOnce({
        key: "agent:main:dashboard:child",
        ...(missing === "sessionId" ? {} : { sessionId: "created-child" }),
        entry: missing === "lifecycleRevision" ? {} : { lifecycleRevision: "birth-revision" },
        runStarted: false,
        runError: "startup failed",
      });
      const tool = createTool({
        agentSessionKey: "agent:main:main",
        config: { agents: { list: [{ id: "main" }] } },
        callGateway,
        countActiveRuns: () => 0,
      });

      const result = await tool.execute("visible-missing-identity", {
        task: "inspect",
        visible: true,
      });

      expect(result.details).toMatchObject({
        status: "error",
        error: expect.stringContaining("Session cleanup unconfirmed."),
        childSessionKey: "agent:main:dashboard:child",
      });
      expect(callGateway).toHaveBeenCalledTimes(1);
    },
  );
}
