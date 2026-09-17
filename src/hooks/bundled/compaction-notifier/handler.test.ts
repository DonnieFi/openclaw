import { describe, expect, it } from "vitest";
import type { InternalHookEvent } from "../../internal-hooks.js";
import handler from "./handler.js";

function makeEvent(
  action: "compact:before" | "compact:after",
  context: Record<string, unknown> = {},
): InternalHookEvent {
  return {
    type: "session",
    action,
    sessionKey: "agent:main:test",
    context,
    timestamp: new Date(0),
    messages: [],
  };
}

describe("compaction-notifier handler", () => {
  it("announces compaction start with an optional message count", async () => {
    const event = makeEvent("compact:before", { messageCount: 12 });
    await handler(event);
    expect(event.messages).toEqual([
      "🧹 Compacting context (12 messages) so I can continue without losing history…",
    ]);
  });

  it("reports a truthful no-op when compactedCount is zero", async () => {
    const event = makeEvent("compact:after", {
      compactedCount: 0,
      tokensBefore: 1_200,
      tokensAfter: 1_200,
    });
    await handler(event);
    expect(event.messages).toEqual(["✅ Nothing to compact. Continuing from where I left off."]);
  });

  it("reports successful compaction with an optional token delta", async () => {
    const event = makeEvent("compact:after", {
      compactedCount: -1,
      tokensBefore: 12_000,
      tokensAfter: 4_000,
    });
    await handler(event);
    expect(event.messages).toEqual([
      "✅ Context compacted (12,000 → 4,000 tokens). Continuing from where I left off.",
    ]);
  });
});
