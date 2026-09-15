// Cron CLI diagnostic ownership tests cover handoff registration and abort wiring (#149198).
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  abortEmbeddedAgentRun,
  resolveActiveEmbeddedRunHandleSessionId,
} from "../../agents/embedded-agent-runner/runs.js";
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
  runEmbeddedAgentMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();
const requireRecord = createRequireRecord("record", "expected-non-array-record");

function makeJob(overrides?: Record<string, unknown>) {
  return {
    id: "model-fwd-job",
    name: "Model Forward Test",
    schedule: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
    sessionTarget: "isolated",
    payload: {
      kind: "agentTurn",
      message: "summarize",
      model: "google/gemini-2.0-flash",
    },
    ...overrides,
  } as never;
}

function makeParams(overrides?: Record<string, unknown>) {
  return {
    cfg: {},
    deps: {} as never,
    job: makeJob(),
    message: "summarize",
    sessionKey: "cron:model-fwd",
    ...overrides,
  };
}

function firstMockArg(mock: { mock: { calls: unknown[][] } }): Record<string, unknown> {
  return requireRecord(mock.mock.calls[0]?.[0]);
}

describe("runCronIsolatedAgentTurn — cron CLI diagnostic ownership (#149198)", () => {
  let previousFastTestEnv: string | undefined;

  beforeEach(() => {
    previousFastTestEnv = clearFastTestEnv();
    resetRunCronIsolatedAgentTurnHarness();
    resolveConfiguredModelRefMock.mockReturnValue({
      provider: "anthropic",
      model: "claude-opus-4-6",
    });
    resolveThinkingDefaultMock.mockReturnValue("off");
    runEmbeddedAgentMock.mockResolvedValue({
      payloads: [{ text: "summary done" }],
      meta: {
        agentMeta: {
          provider: "google",
          model: "gemini-2.0-flash",
          usage: { input: 100, output: 50 },
        },
      },
    });
  });

  afterEach(() => {
    restoreFastTestEnv(previousFastTestEnv);
  });

  it("registers diagnostic CLI ownership for stuck-session recovery during cron CLI runs", async () => {
    isCliProviderMock.mockImplementation((provider: string) => provider === "claude-cli");
    resolveAllowedModelRefMock.mockReturnValue({
      ref: { provider: "claude-cli", model: "claude-opus-4-6" },
    });
    mockRunCronFallbackPassthrough();
    const cronSession = makeCronSession({
      sessionEntry: makeCronSessionEntry({
        sessionId: "cron-cli-diagnostic-session",
      }),
      isNewSession: true,
    });
    resolveCronSessionMock.mockReturnValue(cronSession);
    let activeHandleDuringCli: string | undefined;
    let diagnosticOwnerDuringCli: unknown;
    let cliAbortSignalDuringCli: AbortSignal | undefined;
    runCliAgentMock.mockImplementationOnce(async (runParams) => {
      diagnosticOwnerDuringCli = runParams.diagnosticOwner;
      cliAbortSignalDuringCli = runParams.abortSignal;
      activeHandleDuringCli = resolveActiveEmbeddedRunHandleSessionId(runParams.sessionKey ?? "");
      return {
        payloads: [{ text: "summary done" }],
        meta: {
          durationMs: 1,
          executionTrace: { runner: "cli" },
          agentMeta: {
            provider: "claude-cli",
            model: "claude-opus-4-6",
            usage: { input: 1, output: 1 },
          },
        },
      };
    });

    const result = await runCronIsolatedAgentTurn(
      makeParams({
        job: makeJob({ sessionTarget: "session:existing-cron-session" }),
      }),
    );

    expect(result.status).toBe("ok");
    expect(diagnosticOwnerDuringCli).toEqual(
      expect.objectContaining({
        sessionId: "cron-cli-diagnostic-session",
        generation: expect.anything(),
      }),
    );
    expect(cliAbortSignalDuringCli).toBeInstanceOf(AbortSignal);
    expect(cliAbortSignalDuringCli?.aborted).toBe(false);
    expect(activeHandleDuringCli).toBe("cron-cli-diagnostic-session");
    expect(
      resolveActiveEmbeddedRunHandleSessionId(String(firstMockArg(runCliAgentMock).sessionKey)),
    ).toBeUndefined();
  });

  it("forwards handle abort onto the cron CLI abort signal", async () => {
    isCliProviderMock.mockImplementation((provider: string) => provider === "claude-cli");
    resolveAllowedModelRefMock.mockReturnValue({
      ref: { provider: "claude-cli", model: "claude-opus-4-6" },
    });
    mockRunCronFallbackPassthrough();
    const cronSession = makeCronSession({
      sessionEntry: makeCronSessionEntry({
        sessionId: "cron-cli-abort-session",
      }),
      isNewSession: true,
    });
    resolveCronSessionMock.mockReturnValue(cronSession);
    let seenAbortSignal: AbortSignal | undefined;
    let abortedViaHandle = false;
    runCliAgentMock.mockImplementationOnce(async (runParams) => {
      seenAbortSignal = runParams.abortSignal;
      expect(runParams.abortSignal?.aborted).toBe(false);
      abortedViaHandle = abortEmbeddedAgentRun("cron-cli-abort-session");
      expect(abortedViaHandle).toBe(true);
      expect(runParams.abortSignal?.aborted).toBe(true);
      return {
        payloads: [{ text: "aborted mid-run" }],
        meta: {
          durationMs: 1,
          executionTrace: { runner: "cli" },
          agentMeta: {
            provider: "claude-cli",
            model: "claude-opus-4-6",
            usage: { input: 1, output: 1 },
          },
        },
      };
    });

    const result = await runCronIsolatedAgentTurn(
      makeParams({
        job: makeJob({ sessionTarget: "session:existing-cron-session" }),
      }),
    );

    expect(result.status).toBe("ok");
    expect(seenAbortSignal).toBeInstanceOf(AbortSignal);
    expect(abortedViaHandle).toBe(true);
    expect(seenAbortSignal?.aborted).toBe(true);
  });
});
