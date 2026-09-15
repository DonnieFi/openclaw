import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  abortEmbeddedAgentRun,
  isEmbeddedAgentRunHandleActive,
} from "../../agents/embedded-agent-runner/runs.js";
import type { RunCronAgentTurnParams } from "./run-prepare-runtime.js";
import {
  clearFastTestEnv,
  isCliProviderMock,
  loadRunCronIsolatedAgentTurn,
  makeCronSession,
  makeCronSessionEntry,
  mockRunCronFallbackPassthrough,
  resolveAllowedModelRefMock,
  resolveConfiguredModelRefMock,
  resolveCronSessionMock,
  resolveThinkingDefaultMock,
  resetRunCronIsolatedAgentTurnHarness,
  restoreFastTestEnv,
  runCliAgentMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();
const sessionId = "cron-cli-diagnostic-session";

function makeParams(): RunCronAgentTurnParams {
  return {
    cfg: {},
    deps: {},
    job: {
      id: "cli-diagnostic-job",
      name: "CLI diagnostic ownership",
      enabled: true,
      createdAtMs: 0,
      updatedAtMs: 0,
      schedule: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
      sessionTarget: "session:existing-cron-session",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "summarize", model: "test-cli/test-model" },
      state: {},
    },
    message: "summarize",
    sessionKey: "cron:cli-diagnostic",
  };
}

describe("runCronIsolatedAgentTurn CLI ownership", () => {
  let previousFastTestEnv: string | undefined;

  beforeEach(() => {
    previousFastTestEnv = clearFastTestEnv();
    resetRunCronIsolatedAgentTurnHarness();
    isCliProviderMock.mockImplementation((provider: string) => provider === "test-cli");
    resolveConfiguredModelRefMock.mockReturnValue({ provider: "test-cli", model: "test-model" });
    resolveAllowedModelRefMock.mockReturnValue({
      ref: { provider: "test-cli", model: "test-model" },
    });
    resolveThinkingDefaultMock.mockReturnValue("off");
    resolveCronSessionMock.mockReturnValue(
      makeCronSession({ sessionEntry: makeCronSessionEntry({ sessionId }), isNewSession: true }),
    );
    mockRunCronFallbackPassthrough();
  });

  afterEach(() => {
    restoreFastTestEnv(previousFastTestEnv);
  });

  it("holds diagnostic ownership during CLI execution and releases it after settlement", async () => {
    runCliAgentMock.mockImplementationOnce(async (params) => {
      expect(params.diagnosticOwner).toEqual(
        expect.objectContaining({ sessionId, generation: expect.anything() }),
      );
      expect(params.abortSignal).toBeInstanceOf(AbortSignal);
      expect(params.abortSignal.aborted).toBe(false);
      expect(isEmbeddedAgentRunHandleActive(sessionId)).toBe(true);
      return {
        payloads: [{ text: "summary done" }],
        meta: {
          durationMs: 1,
          executionTrace: { runner: "cli" },
          agentMeta: { provider: "test-cli", model: "test-model", usage: { input: 1, output: 1 } },
        },
      };
    });

    const result = await runCronIsolatedAgentTurn(makeParams());

    expect(result.status).toBe("ok");
    expect(isEmbeddedAgentRunHandleActive(sessionId)).toBe(false);
  });

  it("preserves handle cancellation as a terminal abort when the CLI rejects", async () => {
    runCliAgentMock.mockImplementationOnce(async (params) => {
      expect(params.abortSignal.aborted).toBe(false);
      expect(abortEmbeddedAgentRun(sessionId)).toBe(true);
      expect(params.abortSignal.aborted).toBe(true);
      throw Object.assign(new Error("CLI run aborted"), { name: "AbortError" });
    });

    const result = await runCronIsolatedAgentTurn(makeParams());

    expect(result.status).toBe("error");
    expect(result.error).toBe("agent run aborted | OPENCLAW_DIRECT_ABORT");
    expect(isEmbeddedAgentRunHandleActive(sessionId)).toBe(false);
  });
});
