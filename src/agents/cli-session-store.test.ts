import { describe, expect, it } from "vitest";
import {
  isSessionPlacementTurnSettlementClosedError,
  settleCliSessionResult,
} from "./cli-session-store.js";
import type { EmbeddedAgentRunResult } from "./embedded-agent-runner/types.js";

function makeResult(): EmbeddedAgentRunResult {
  return {
    payloads: [{ text: "done" }],
    meta: {
      agentMeta: { usage: { input: 1, output: 2 } },
    },
  };
}

describe("cli-session-store", () => {
  it("detects closed placement settlement errors", () => {
    expect(
      isSessionPlacementTurnSettlementClosedError(
        new Error("session placement turn settlement is closed"),
      ),
    ).toBe(true);
    expect(isSessionPlacementTurnSettlementClosedError(new Error("other failure"))).toBe(false);
  });

  it("retries settle without placement assertion when settlement closed", async () => {
    let guardedAttempt = 0;
    const result = await settleCliSessionResult(
      makeResult(),
      async () => {
        guardedAttempt += 1;
        throw new Error("session placement turn settlement is closed");
      },
      {
        retrySettleWithoutPlacementAssertion: async () => undefined,
      },
    );
    expect(guardedAttempt).toBe(1);
    expect(result.meta.error).toBeUndefined();
    expect(result.payloads).toEqual([{ text: "done" }]);
  });

  it("fails when settlement-closed retry also fails", async () => {
    const result = await settleCliSessionResult(
      makeResult(),
      async () => {
        throw new Error("session placement turn settlement is closed");
      },
      {
        retrySettleWithoutPlacementAssertion: async () => {
          throw new Error("lifecycle claim lost");
        },
      },
    );
    expect(result.meta.replayInvalid).toBe(true);
    expect(result.meta.error?.message).toContain("CLI session continuity could not be saved");
    expect(result.meta.error?.message).toContain("lifecycle claim lost");
  });
});
