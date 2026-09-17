// Correlated CLI tool results already carry their started args; display-only
// results must not duplicate that potentially large payload.
import { describe, expect, it, vi } from "vitest";
import { type AgentEventRuntimePayload, onAgentEvent } from "../../infra/agent-events.js";
import { createTestAdmittedRunContext } from "../admitted-run-context.test-support.js";
import { createCliEventHandlers } from "./execute-events.js";
import type { CliToolTracking } from "./execute-tool-tracking.js";
import type { PreparedCliRunContext } from "./types.js";

function buildContext(runId: string): PreparedCliRunContext {
  const backend = {
    command: "claude",
    args: [],
    output: "jsonl" as const,
    input: "stdin" as const,
    serialize: true,
  };
  return {
    params: {
      admittedRunContext: createTestAdmittedRunContext(runId),
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:main",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      prompt: "hi",
      provider: "claude-cli",
      model: "claude-haiku-4-5",
      timeoutMs: 1_000,
      runId,
    },
    started: Date.now(),
    workspaceDir: "/tmp",
    backendResolved: { id: "claude-cli", config: backend, bundleMcp: false },
    preparedBackend: { backend, env: {} },
    executionTarget: { kind: "process" },
    reusableCliSession: { mode: "none" },
    hadSessionFile: false,
    contextEngineConfig: {},
    modelId: "claude-haiku-4-5",
    normalizedModel: "claude-haiku-4-5",
    systemPrompt: "system",
    systemPromptReport: {} as PreparedCliRunContext["systemPromptReport"],
    claudeSkillsPluginArgs: [],
    authEpochVersion: 2,
  } as PreparedCliRunContext;
}

function buildToolTracking(): CliToolTracking {
  return {
    handleCliToolUseStart: vi.fn(),
    handleCliToolResult: vi.fn(),
    resolveCliLoopbackTerminalOutcome: vi.fn(() => undefined),
    beginGatewayCapture: vi.fn(),
  } as unknown as CliToolTracking;
}

function collectRunEvents(
  runId: string,
  streams: readonly string[],
): {
  events: AgentEventRuntimePayload[];
  dispose: () => void;
} {
  const wanted = new Set(streams);
  const events: AgentEventRuntimePayload[] = [];
  const dispose = onAgentEvent((event) => {
    if (event.runId === runId && wanted.has(event.stream)) {
      events.push(event);
    }
  });
  return { events, dispose };
}

function collectToolEvents(runId: string): {
  events: AgentEventRuntimePayload[];
  dispose: () => void;
} {
  return collectRunEvents(runId, ["tool"]);
}

const PROGRESS_CARD_PLAN_ARGS = {
  plan: [
    { step: "Inspect the failing route", status: "completed" },
    { step: "Repair the session owner", status: "in_progress" },
    { step: "Run focused verification", status: "pending" },
  ],
};

const EXPECTED_PROGRESS_CARD_PLAN_DATA = {
  phase: "update",
  title: "Plan updated",
  source: "openclaw",
  explanation: "1/3 complete",
  steps: PROGRESS_CARD_PLAN_ARGS.plan,
};

describe("cli tool result events", () => {
  it("emits complete CLI commentary as a completed preamble", () => {
    const runId = "run-commentary-complete";
    const handlers = createCliEventHandlers({
      context: buildContext(runId),
      toolTracking: buildToolTracking(),
      getRunState: () => ({ failed: false, error: undefined }),
    });
    const events: AgentEventRuntimePayload[] = [];
    const dispose = onAgentEvent((event) => {
      if (event.runId === runId && event.stream === "item") {
        events.push(event);
      }
    });
    try {
      // The JSONL parser has already accumulated this whole pre-tool segment.
      // An update-only event would leave first-notification buffering waiting forever.
      handlers.emitCliCommentaryText("Let me check that for you.");
      expect(events).toMatchObject([
        {
          stream: "item",
          data: { kind: "preamble", phase: "end", progressText: "Let me check that for you." },
        },
      ]);
    } finally {
      dispose();
    }
  });

  it("emits canonical CLI compaction lifecycle events", () => {
    const runId = "run-compaction-events";
    const handlers = createCliEventHandlers({
      context: buildContext(runId),
      toolTracking: buildToolTracking(),
      getRunState: () => ({ failed: false, error: undefined }),
    });
    const events: AgentEventRuntimePayload[] = [];
    const dispose = onAgentEvent((event) => {
      if (event.runId === runId && event.stream === "compaction") {
        events.push(event);
      }
    });

    try {
      handlers.emitCliCompaction({ phase: "start" });
      handlers.emitCliCompaction({ phase: "end", completed: true });

      expect(events.map((event) => event.data)).toEqual([
        { phase: "start", backend: "claude-cli" },
        { phase: "end", backend: "claude-cli", completed: true },
      ]);
    } finally {
      dispose();
    }
  });

  it("keeps correlated result args without adding them to display results", () => {
    const runId = "run-tool-result-args";
    const handlers = createCliEventHandlers({
      context: buildContext(runId),
      toolTracking: buildToolTracking(),
      getRunState: () => ({ failed: false, error: undefined }),
    });
    const { events, dispose } = collectToolEvents(runId);

    try {
      handlers.emitCliToolUseStart({
        toolCallId: "call-1",
        name: "Bash",
        kind: "tool_use",
        args: { command: "nope-not-a-command" },
      });
      handlers.emitCliToolResult({
        toolCallId: "call-1",
        name: "Bash",
        isError: true,
        result: "bash: nope-not-a-command: command not found",
      });
      handlers.emitCliDisplayToolUseStart({
        toolCallId: "call-2",
        name: "write",
        kind: "tool_use",
        args: { path: "note.txt", content: "hello" },
      });
      handlers.emitCliDisplayToolResult({
        toolCallId: "call-2",
        name: "write",
        isError: false,
        result: "wrote note.txt",
      });
      // The display result also releases correlation state for this call id.
      handlers.emitCliToolResult({
        toolCallId: "call-2",
        name: "write",
        isError: false,
        result: "duplicate terminal",
      });

      const results = events.filter((event) => event.data.phase === "result");
      expect(results[0]?.data.args).toEqual({ command: "nope-not-a-command" });
      expect(results[0]?.data.isError).toBe(true);
      expect(results[1]?.data.args).toBeUndefined();
      expect(results[1]?.data.isError).toBe(false);
      expect(results[2]?.data.args).toBeUndefined();
    } finally {
      dispose();
    }
  });

  it("forgets a call's args once it reports, so ids cannot leak across calls", () => {
    const runId = "run-tool-result-args-forget";
    const handlers = createCliEventHandlers({
      context: buildContext(runId),
      toolTracking: buildToolTracking(),
      getRunState: () => ({ failed: false, error: undefined }),
    });
    const { events, dispose } = collectToolEvents(runId);

    try {
      handlers.emitCliToolUseStart({
        toolCallId: "call-1",
        name: "Bash",
        kind: "tool_use",
        args: { command: "first" },
      });
      handlers.emitCliToolResult({
        toolCallId: "call-1",
        name: "Bash",
        isError: false,
        result: "",
      });
      // A second result for the same id must not reuse the first call's request.
      handlers.emitCliToolResult({
        toolCallId: "call-1",
        name: "Bash",
        isError: false,
        result: "",
      });

      const results = events.filter((event) => event.data.phase === "result");
      expect(results[0]?.data.args).toEqual({ command: "first" });
      expect(results[1]?.data.args).toBeUndefined();
    } finally {
      dispose();
    }
  });

  it("projects a successful prefixed progress_card result onto the plan stream", () => {
    const runId = "run-progress-card-plan";
    const handlers = createCliEventHandlers({
      context: buildContext(runId),
      toolTracking: buildToolTracking(),
      getRunState: () => ({ failed: false, error: undefined }),
    });
    const { events, dispose } = collectRunEvents(runId, ["plan", "tool"]);

    try {
      handlers.emitParsedToolUseStart({
        toolCallId: "call-plan",
        name: "mcp__openclaw__progress_card",
        kind: "mcp_tool_use",
        args: PROGRESS_CARD_PLAN_ARGS,
      });
      handlers.emitParsedToolResult({
        toolCallId: "call-plan",
        name: "mcp__openclaw__progress_card",
        isError: false,
        result: { content: [{ type: "text", text: "Progress card updated (rev 2, 1/3 done)" }] },
      });

      expect(events.filter((event) => event.stream === "plan")).toEqual([
        expect.objectContaining({
          stream: "plan",
          data: EXPECTED_PROGRESS_CARD_PLAN_DATA,
        }),
      ]);
      expect(
        events.find((event) => event.stream === "tool" && event.data.phase === "result")?.data.name,
      ).toBe("mcp__openclaw__progress_card");
    } finally {
      dispose();
    }
  });

  it("keeps failed prefixed progress_card writes off the plan stream", () => {
    const runId = "run-progress-card-plan-error";
    const handlers = createCliEventHandlers({
      context: buildContext(runId),
      toolTracking: buildToolTracking(),
      getRunState: () => ({ failed: false, error: undefined }),
    });
    const { events, dispose } = collectRunEvents(runId, ["plan"]);

    try {
      handlers.emitParsedToolUseStart({
        toolCallId: "call-plan-error",
        name: "mcp__openclaw__progress_card",
        kind: "mcp_tool_use",
        args: PROGRESS_CARD_PLAN_ARGS,
      });
      handlers.emitParsedToolResult({
        toolCallId: "call-plan-error",
        name: "mcp__openclaw__progress_card",
        isError: true,
        result: { content: [{ type: "text", text: "Card write failed" }] },
      });

      expect(events).toEqual([]);
    } finally {
      dispose();
    }
  });

  it("emits an empty plan snapshot when a successful prefixed write clears the card", () => {
    const runId = "run-progress-card-plan-clear";
    const handlers = createCliEventHandlers({
      context: buildContext(runId),
      toolTracking: buildToolTracking(),
      getRunState: () => ({ failed: false, error: undefined }),
    });
    const { events, dispose } = collectRunEvents(runId, ["plan"]);

    try {
      handlers.emitParsedToolUseStart({
        toolCallId: "call-plan-clear",
        name: "mcp__openclaw__progress_card",
        kind: "mcp_tool_use",
        args: {},
      });
      handlers.emitParsedToolResult({
        toolCallId: "call-plan-clear",
        name: "mcp__openclaw__progress_card",
        isError: false,
        result: { content: [{ type: "text", text: "Progress card cleared" }] },
      });

      expect(events).toEqual([
        expect.objectContaining({
          stream: "plan",
          data: {
            phase: "update",
            title: "Plan updated",
            source: "openclaw",
            steps: [],
          },
        }),
      ]);
    } finally {
      dispose();
    }
  });
});
