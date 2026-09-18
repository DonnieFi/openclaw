import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Model,
  type Message,
} from "openclaw/plugin-sdk/llm";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import type { ContextEngine } from "../../../context-engine/types.js";
import { Agent, type AgentMessage } from "../../runtime/index.js";
import {
  createAssistant,
  createAssistantResultStream,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
} from "../../sessions/agent-session-loop-correctness.test-support.js";
import { makeAgentAssistantMessage } from "../../test-helpers/agent-message-fixtures.js";
import { makeProviderModelFixture } from "../../test-helpers/provider-model-fixture.js";
import { createZeroUsageFixture } from "../../test-helpers/usage-fixtures.js";
import {
  clearEmbeddedSessionPromptStates,
  createToolResultPromptProjectionState,
  getEmbeddedSessionPromptState,
} from "../session-prompt-state.js";
import { installContextEngineLoopHook } from "../tool-result-context-guard.js";
import { prepareEmbeddedAttemptPromptContext } from "./attempt-prompt-build.js";
import { submitEmbeddedAttemptPrompt } from "./attempt-prompt-submit.js";
import { installEmbeddedAttemptContextGuards } from "./attempt-setup.js";

registerAgentSessionLoopTestLifecycle();

function redactedModelRequestSummary(messages: Message[]): Array<Record<string, unknown>> {
  return messages.map((message) => {
    if (message.role === "user") {
      const content = (message as { content?: unknown }).content;
      let text = "";
      if (typeof content === "string") {
        text = content;
      } else if (Array.isArray(content)) {
        text = content
          .filter(
            (block) =>
              block &&
              typeof block === "object" &&
              (block as { type?: unknown }).type === "text" &&
              typeof (block as { text?: unknown }).text === "string",
          )
          .map((block) => (block as { text: string }).text)
          .join("");
      }
      return { role: "user", text };
    }
    if (message.role === "toolResult") {
      return {
        role: "toolResult",
        toolCallId: (message as { toolCallId?: string }).toolCallId,
      };
    }
    if (message.role === "assistant") {
      const content = (message as { content?: unknown }).content;
      const hasToolCall =
        Array.isArray(content) &&
        content.some(
          (block) =>
            block && typeof block === "object" && (block as { type?: unknown }).type === "toolCall",
        );
      return { role: "assistant", hasToolCall };
    }
    return { role: message.role };
  });
}

const model: Model = makeProviderModelFixture({
  id: "synthetic-model",
  name: "Synthetic",
  api: "openai-responses",
  provider: "synthetic",
  baseUrl: "http://127.0.0.1:1",
  contextWindow: 8192,
  maxTokens: 1024,
});
const usage = createZeroUsageFixture();

describe("context advancement through embedded attempt guards", () => {
  it.each(
    (["afterTurn", "ingestBatch", "ingest"] as const).flatMap((ingestion) =>
      (["stop", "error", "aborted"] as const).flatMap((terminal) =>
        (["stored-prefix", "live-input"] as const).map((assembly) => ({
          ingestion,
          terminal,
          assembly,
        })),
      ),
    ),
  )(
    "preserves live context with $assembly assembly and defers $ingestion after $terminal",
    async ({ ingestion, terminal, assembly }) => {
      const remembered: AgentMessage[] = [];
      const history: AgentMessage[] = [
        { role: "user", content: "Earlier accepted request.", timestamp: 0 },
        makeAgentAssistantMessage({
          content: [{ type: "text", text: "Earlier accepted answer." }],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage,
        }),
      ];
      const storedPrefix: AgentMessage[] = [
        { role: "user", content: "Summary of accepted history.", timestamp: 0 },
      ];
      const assemble = vi.fn<ContextEngine["assemble"]>(async ({ messages }) => ({
        messages: assembly === "stored-prefix" ? storedPrefix : messages,
        estimatedTokens: 0,
      }));
      const commitTurn = vi.fn<NonNullable<ContextEngine["commitTurn"]>>(async () => ({
        status: "committed",
      }));
      const engine: ContextEngine = {
        info: {
          id: "synthetic-engine",
          name: "Synthetic",
          ownsCompaction: true,
          transcriptSemantics: {
            currentTurnFence: "before-current-turn-entry-v1",
            turnAdvancementIdempotency: "atomic-idempotent-v1",
          },
        },
        ingest: async ({ message }) => {
          remembered.push(message);
          return { ingested: true };
        },
        ...(ingestion === "afterTurn"
          ? {
              afterTurn: async ({
                messages,
                prePromptMessageCount,
              }: Parameters<NonNullable<ContextEngine["afterTurn"]>>[0]) => {
                remembered.push(...messages.slice(prePromptMessageCount));
              },
            }
          : {}),
        ...(ingestion === "ingestBatch"
          ? {
              ingestBatch: async ({
                messages,
              }: Parameters<NonNullable<ContextEngine["ingestBatch"]>>[0]) => {
                remembered.push(...messages);
                return { ingestedCount: messages.length };
              },
            }
          : {}),
        assemble,
        compact: async () => ({ ok: true, compacted: false, reason: "fits" }),
        commitTurn,
      };
      let providerCalls = 0;
      let secondModelMessages: Message[] | undefined;
      const execute = vi.fn(async () => ({
        content: [{ type: "text" as const, text: "fixture observation" }],
        details: {},
      }));
      const agent = new Agent({
        initialState: {
          model,
          messages: history,
          tools: [
            {
              name: "read_fixture",
              label: "Read fixture",
              description: "Read fixture",
              parameters: { type: "object", properties: {} },
              execute,
            },
          ],
        },
        streamFn: (_model, context) => {
          providerCalls++;
          if (providerCalls === 2) {
            secondModelMessages = structuredClone(context.messages);
          }
          const stopReason = providerCalls === 1 ? "toolUse" : terminal;
          if (stopReason === "aborted") {
            agent.abort();
          }
          const message: AssistantMessage = makeAgentAssistantMessage({
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage,
            timestamp: 1,
            content:
              stopReason === "toolUse"
                ? [{ type: "toolCall", id: "read-1", name: "read_fixture", arguments: {} }]
                : [{ type: "text", text: "done" }],
            stopReason,
          });
          const stream = createAssistantMessageEventStream();
          stream.push(
            stopReason === "error" || stopReason === "aborted"
              ? { type: "error", reason: stopReason, error: message }
              : { type: "done", reason: stopReason, message },
          );
          stream.end();
          return stream;
        },
      });
      const guards = installEmbeddedAttemptContextGuards({
        activeContextEngine: engine,
        activeSession: { agent },
        agentDir: process.cwd(),
        attempt: {
          config: {},
          prompt: "Read the fixture.",
          contextTokenBudget: 8192,
          model,
          modelId: model.id,
          provider: model.provider,
          sessionId: "synthetic-session",
          sessionKey: "agent:synthetic:main",
          sessionFile: "unused",
          onContextEngineTurnCandidate: vi.fn(),
        },
        computerContextEpoch: { value: 0 },
        dropThinkingBlocksForEstimate: false,
        effectiveCwd: process.cwd(),
        effectiveFsWorkspaceOnly: true,
        effectiveWorkspace: process.cwd(),
        getPrePromptMessageCount: () => history.length,
        getPromptCache: () => ({ retention: "none" }),
        getPromptCacheRetention: () => "none",
        getCompactionReplayEnabled: () => false,
        getServerToolClearingEnabled: () => false,
        toolResultPromptProjectionState: createToolResultPromptProjectionState(),
        getSystemPrompt: () => "",
        isOpenAIResponsesApi: false,
        repairToolUseResultPairing: false,
        sessionAgentId: "synthetic",
        sessionManager: {},
        settingsManager: { getBlockImages: () => false, getCompactionReserveTokens: () => 64 },
      } as never);
      try {
        await agent.prompt("Read the fixture.");
        expect(providerCalls).toBe(2);
        expect(execute).toHaveBeenCalledOnce();
        expect(
          agent.state.messages.toReversed().find((message) => message.role === "assistant")
            ?.stopReason,
        ).toBe(terminal);
        expect(assemble).toHaveBeenCalledTimes(2);
        expect(secondModelMessages).toMatchObject([
          ...(assembly === "stored-prefix" ? storedPrefix : history),
          { role: "user", content: [{ type: "text", text: "Read the fixture." }] },
          {
            role: "assistant",
            content: [{ type: "toolCall", id: "read-1", name: "read_fixture", arguments: {} }],
          },
          {
            role: "toolResult",
            toolCallId: "read-1",
            content: [{ type: "text", text: "fixture observation" }],
          },
        ]);
        expect(assemble.mock.calls[1]?.[0]).toMatchObject({
          prompt: "Read the fixture.",
          availableTools: new Set(["read_fixture"]),
        });
        expect(assemble.mock.calls[1]?.[0].tokenBudget).toBeLessThan(8192);
        expect(commitTurn).not.toHaveBeenCalled();
        expect(remembered).toEqual([]);
        expect(guards.getAfterTurnCheckpoint()).toBeNull();
      } finally {
        agent.abort();
        await agent.waitForIdle();
        guards.remove();
      }
    },
  );

  it.each([0, 6])(
    "preserves active content through prompt preparation and submission with %i silent replay messages",
    async (silentCount) => {
      const prompt = "Perform task with tools.";
      const sessionId = `replay-boundary-${silentCount}`;
      const storedPrefix: AgentMessage[] = [
        { role: "user", content: "Summary of accepted history.", timestamp: 0 },
      ];
      const engine: ContextEngine = {
        info: {
          id: "synthetic-engine",
          name: "Synthetic",
          ownsCompaction: true,
          transcriptSemantics: {
            currentTurnFence: "before-current-turn-entry-v1",
            turnAdvancementIdempotency: "atomic-idempotent-v1",
          },
        },
        ingest: async () => ({ ingested: true }),
        assemble: async () => ({ messages: storedPrefix, estimatedTokens: 0 }),
        compact: async () => ({ ok: true, compacted: false, reason: "fits" }),
        commitTurn: async () => ({ status: "committed" }),
      };
      let toolCalls = 0;
      const { session } = await createTestSession({
        model,
        customTools: [
          {
            name: "read_fixture",
            label: "Read fixture",
            description: "Read fixture",
            parameters: Type.Object({}),
            execute: async () => ({
              content: [{ type: "text", text: `fixture observation ${++toolCalls}` }],
              details: {},
            }),
          },
        ],
      });
      session.agent.state.messages = [
        { role: "user", content: "Earlier accepted request.", timestamp: 0 },
        createAssistant(model, [{ type: "text", text: "Earlier accepted answer." }]),
        ...Array.from({ length: silentCount }, () =>
          createAssistant(model, [{ type: "text", text: "NO_REPLY" }]),
        ),
      ];
      const modelRequests: Message[][] = [];
      session.agent.streamFn = (_model, context) => {
        modelRequests.push(structuredClone(context.messages));
        const round = modelRequests.length;
        return createAssistantResultStream(
          createAssistant(
            model,
            round <= 2
              ? [{ type: "toolCall", id: `call-${round}`, name: "read_fixture", arguments: {} }]
              : [{ type: "text", text: "done" }],
            round <= 2 ? "toolUse" : "stop",
          ),
        );
      };
      const sessionPromptState = getEmbeddedSessionPromptState(sessionId);
      const sessionRuntimeState = { prePromptMessageCount: session.messages.length };
      const guards = installEmbeddedAttemptContextGuards({
        activeContextEngine: engine,
        activeSession: session,
        agentDir: process.cwd(),
        attempt: {
          config: {},
          prompt,
          contextTokenBudget: 8192,
          model,
          modelId: model.id,
          provider: model.provider,
          sessionId,
          sessionKey: `agent:${sessionId}:main`,
          sessionFile: "unused",
          onContextEngineTurnCandidate: vi.fn(),
        },
        computerContextEpoch: { value: 0 },
        dropThinkingBlocksForEstimate: false,
        effectiveCwd: process.cwd(),
        effectiveFsWorkspaceOnly: true,
        effectiveWorkspace: process.cwd(),
        getPrePromptMessageCount: () => sessionRuntimeState.prePromptMessageCount,
        getPromptCache: () => ({ retention: "none" }),
        getPromptCacheRetention: () => "none",
        getCompactionReplayEnabled: () => false,
        getServerToolClearingEnabled: () => false,
        toolResultPromptProjectionState: sessionPromptState.toolResults,
        getSystemPrompt: () => "",
        isOpenAIResponsesApi: false,
        repairToolUseResultPairing: false,
        sessionAgentId: "synthetic",
        sessionManager: {},
        settingsManager: { getBlockImages: () => false, getCompactionReserveTokens: () => 64 },
      } as never);
      const promptContext = await prepareEmbeddedAttemptPromptContext({
        attempt: { config: {}, contextTokenBudget: 8192, sessionId },
        capabilityToolNames: new Set(["read_fixture"]),
        includeBoundaryTimestamp: false,
        isRawModelRun: false,
        messages: session.messages,
        prompt: { effectivePrompt: prompt, effectiveTranscriptPrompt: prompt },
        replaceSessionMessages: (messages) => {
          session.agent.state.messages = messages;
        },
        sessionAgentId: "synthetic",
        systemPromptText: "",
        toolResultPromptProjectionState: sessionPromptState.toolResults,
      });
      sessionRuntimeState.prePromptMessageCount = promptContext.prePromptMessageCount;
      try {
        await submitEmbeddedAttemptPrompt({
          attempt: { sessionId },
          activeSession: session,
          contextTokenBudget: promptContext.contextTokenBudget,
          images: [],
          modelPrompt: promptContext.promptForModel,
          onFinalPromptText: () => {},
          onSteeringAcknowledged: () => {},
          persistToolResultProjections: async () => {},
          promptActiveSession: (text, options) => session.prompt(text, options),
          runtimeOnly: false,
          sessionPromptState,
          systemPrompt: "",
          toolResultAggregateMaxChars: promptContext.promptToolResultAggregateMaxChars,
          toolResultMaxChars: promptContext.promptToolResultMaxChars,
          toolResultPromptProjectionState: sessionPromptState.toolResults,
          trajectoryRecorder: null,
          transcriptLeafId: null,
          transcriptPrompt: promptContext.promptForSession,
        });
        expect(modelRequests).toHaveLength(3);
        expect(toolCalls).toBe(2);
        for (const messages of modelRequests) {
          expect(messages).toContainEqual(
            expect.objectContaining({
              role: "user",
              content: [{ type: "text", text: prompt }],
            }),
          );
        }
        for (const [index, messages] of modelRequests.entries()) {
          for (let round = 1; round <= index; round++) {
            expect(messages).toContainEqual(
              expect.objectContaining({
                role: "assistant",
                content: [
                  { type: "toolCall", id: `call-${round}`, name: "read_fixture", arguments: {} },
                ],
              }),
            );
            expect(messages).toContainEqual(
              expect.objectContaining({
                role: "toolResult",
                toolCallId: `call-${round}`,
                content: [{ type: "text", text: `fixture observation ${round}` }],
              }),
            );
          }
        }
      } finally {
        guards.remove();
        clearEmbeddedSessionPromptStates([sessionId]);
      }
    },
  );

  it("keeps the current task after a stale pre-prompt fence is clamped for deferred slicing", async () => {
    const prompt = "Perform task with tools.";
    const sessionId = "replay-boundary-stale-fence";
    const storedPrefix: AgentMessage[] = [
      { role: "user", content: "Summary of accepted history.", timestamp: 0 },
    ];
    const engine: ContextEngine = {
      info: {
        id: "synthetic-engine",
        name: "Synthetic",
        ownsCompaction: true,
        transcriptSemantics: {
          currentTurnFence: "before-current-turn-entry-v1",
          turnAdvancementIdempotency: "atomic-idempotent-v1",
        },
      },
      ingest: async () => ({ ingested: true }),
      assemble: async () => ({ messages: storedPrefix, estimatedTokens: 0 }),
      compact: async () => ({ ok: true, compacted: false, reason: "fits" }),
      commitTurn: async () => ({ status: "committed" }),
    };
    let toolCalls = 0;
    const { session } = await createTestSession({
      model,
      customTools: [
        {
          name: "read_fixture",
          label: "Read fixture",
          description: "Read fixture",
          parameters: Type.Object({}),
          execute: async () => ({
            content: [{ type: "text", text: `fixture observation ${++toolCalls}` }],
            details: {},
          }),
        },
      ],
    });
    session.agent.state.messages = [
      { role: "user", content: "Earlier accepted request.", timestamp: 0 },
      createAssistant(model, [{ type: "text", text: "Earlier accepted answer." }]),
      ...Array.from({ length: 6 }, () =>
        createAssistant(model, [{ type: "text", text: "NO_REPLY" }]),
      ),
    ];
    const staleFence = session.messages.length;
    const modelRequests: Message[][] = [];
    session.agent.streamFn = (_model, context) => {
      modelRequests.push(structuredClone(context.messages));
      const round = modelRequests.length;
      return createAssistantResultStream(
        createAssistant(
          model,
          round <= 2
            ? [{ type: "toolCall", id: `call-${round}`, name: "read_fixture", arguments: {} }]
            : [{ type: "text", text: "done" }],
          round <= 2 ? "toolUse" : "stop",
        ),
      );
    };
    const sessionPromptState = getEmbeddedSessionPromptState(sessionId);
    const promptContext = await prepareEmbeddedAttemptPromptContext({
      attempt: { config: {}, contextTokenBudget: 8192, sessionId },
      capabilityToolNames: new Set(["read_fixture"]),
      includeBoundaryTimestamp: false,
      isRawModelRun: false,
      messages: session.messages,
      prompt: { effectivePrompt: prompt, effectiveTranscriptPrompt: prompt },
      replaceSessionMessages: (messages) => {
        session.agent.state.messages = messages;
      },
      sessionAgentId: "synthetic",
      systemPromptText: "",
      toolResultPromptProjectionState: sessionPromptState.toolResults,
    });
    expect(staleFence).toBeGreaterThan(promptContext.prePromptMessageCount);
    const runtimeState = { prePromptMessageCount: staleFence };
    const removeLoopHook = installContextEngineLoopHook({
      agent: session.agent,
      contextEngine: engine,
      sessionId,
      sessionFile: "unused",
      tokenBudget: 8192,
      modelId: model.id,
      getPrePromptMessageCount: () => runtimeState.prePromptMessageCount,
      deferredTurn: { prompt, availableTools: new Set(["read_fixture"]) },
    });
    try {
      await session.agent.transformContext?.(session.messages);
      await submitEmbeddedAttemptPrompt({
        attempt: { sessionId },
        activeSession: session,
        contextTokenBudget: promptContext.contextTokenBudget,
        images: [],
        modelPrompt: promptContext.promptForModel,
        onFinalPromptText: () => {},
        onSteeringAcknowledged: () => {},
        persistToolResultProjections: async () => {},
        promptActiveSession: (text, options) => session.prompt(text, options),
        runtimeOnly: false,
        sessionPromptState,
        systemPrompt: "",
        toolResultAggregateMaxChars: promptContext.promptToolResultAggregateMaxChars,
        toolResultMaxChars: promptContext.promptToolResultMaxChars,
        toolResultPromptProjectionState: sessionPromptState.toolResults,
        trajectoryRecorder: null,
        transcriptLeafId: null,
        transcriptPrompt: promptContext.promptForSession,
      });
      expect(modelRequests).toHaveLength(3);
      expect(toolCalls).toBe(2);
      for (const messages of modelRequests) {
        expect(messages).toContainEqual(
          expect.objectContaining({
            role: "user",
            content: [{ type: "text", text: prompt }],
          }),
        );
      }
      expect(modelRequests[1]).toContainEqual(
        expect.objectContaining({
          role: "toolResult",
          toolCallId: "call-1",
          content: [{ type: "text", text: "fixture observation 1" }],
        }),
      );
      expect(modelRequests[2]).toContainEqual(
        expect.objectContaining({
          role: "toolResult",
          toolCallId: "call-1",
          content: [{ type: "text", text: "fixture observation 1" }],
        }),
      );
      expect(modelRequests[2]).toContainEqual(
        expect.objectContaining({
          role: "toolResult",
          toolCallId: "call-2",
          content: [{ type: "text", text: "fixture observation 2" }],
        }),
      );
    } finally {
      removeLoopHook();
      clearEmbeddedSessionPromptStates([sessionId]);
    }
  });

  it("records redacted model requests through production context guards and prompt phase", async () => {
    const prompt = "Perform task with tools.";
    const sessionId = "replay-boundary-production-runner";
    const storedPrefix: AgentMessage[] = [
      { role: "user", content: "Summary of accepted history.", timestamp: 0 },
    ];
    const engine: ContextEngine = {
      info: {
        id: "synthetic-engine",
        name: "Synthetic",
        ownsCompaction: true,
        transcriptSemantics: {
          currentTurnFence: "before-current-turn-entry-v1",
          turnAdvancementIdempotency: "atomic-idempotent-v1",
        },
      },
      ingest: async () => ({ ingested: true }),
      assemble: async () => ({ messages: storedPrefix, estimatedTokens: 0 }),
      compact: async () => ({ ok: true, compacted: false, reason: "fits" }),
      commitTurn: async () => ({ status: "committed" }),
    };
    let toolCalls = 0;
    const { session } = await createTestSession({
      model,
      customTools: [
        {
          name: "read_fixture",
          label: "Read fixture",
          description: "Read fixture",
          parameters: Type.Object({}),
          execute: async () => ({
            content: [{ type: "text", text: `fixture observation ${++toolCalls}` }],
            details: {},
          }),
        },
      ],
    });
    session.agent.state.messages = [
      { role: "user", content: "Earlier accepted request.", timestamp: 0 },
      createAssistant(model, [{ type: "text", text: "Earlier accepted answer." }]),
      ...Array.from({ length: 6 }, () =>
        createAssistant(model, [{ type: "text", text: "NO_REPLY" }]),
      ),
    ];
    const sessionRuntimeState = { prePromptMessageCount: session.messages.length };
    const rawTranscriptFence = sessionRuntimeState.prePromptMessageCount;
    const modelRequests: Message[][] = [];
    session.agent.streamFn = (_model, context) => {
      modelRequests.push(structuredClone(context.messages));
      const round = modelRequests.length;
      return createAssistantResultStream(
        createAssistant(
          model,
          round <= 2
            ? [{ type: "toolCall", id: `call-${round}`, name: "read_fixture", arguments: {} }]
            : [{ type: "text", text: "done" }],
          round <= 2 ? "toolUse" : "stop",
        ),
      );
    };
    const sessionPromptState = getEmbeddedSessionPromptState(sessionId);
    const guards = installEmbeddedAttemptContextGuards({
      activeContextEngine: engine,
      activeSession: session,
      agentDir: process.cwd(),
      attempt: {
        config: {},
        prompt,
        contextTokenBudget: 8192,
        model,
        modelId: model.id,
        provider: model.provider,
        sessionId,
        sessionKey: `agent:${sessionId}:main`,
        sessionFile: "unused",
        onContextEngineTurnCandidate: vi.fn(),
      },
      computerContextEpoch: { value: 0 },
      dropThinkingBlocksForEstimate: false,
      effectiveCwd: process.cwd(),
      effectiveFsWorkspaceOnly: true,
      effectiveWorkspace: process.cwd(),
      getPrePromptMessageCount: () => sessionRuntimeState.prePromptMessageCount,
      getPromptCache: () => ({ retention: "none" }),
      getPromptCacheRetention: () => "none",
      getCompactionReplayEnabled: () => false,
      getServerToolClearingEnabled: () => false,
      toolResultPromptProjectionState: sessionPromptState.toolResults,
      getSystemPrompt: () => "",
      isOpenAIResponsesApi: false,
      repairToolUseResultPairing: false,
      sessionAgentId: "synthetic",
      sessionManager: {},
      settingsManager: { getBlockImages: () => false, getCompactionReserveTokens: () => 64 },
    } as never);
    try {
      const promptContext = await prepareEmbeddedAttemptPromptContext({
        attempt: { config: {}, contextTokenBudget: 8192, sessionId },
        capabilityToolNames: new Set(["read_fixture"]),
        includeBoundaryTimestamp: false,
        isRawModelRun: false,
        messages: session.messages,
        prompt: { effectivePrompt: prompt, effectiveTranscriptPrompt: prompt },
        replaceSessionMessages: (messages) => {
          session.agent.state.messages = messages;
        },
        sessionAgentId: "synthetic",
        systemPromptText: "",
        toolResultPromptProjectionState: sessionPromptState.toolResults,
      });
      expect(rawTranscriptFence).toBeGreaterThan(promptContext.prePromptMessageCount);
      sessionRuntimeState.prePromptMessageCount = promptContext.prePromptMessageCount;
      expect(sessionRuntimeState.prePromptMessageCount).toBe(promptContext.prePromptMessageCount);

      await submitEmbeddedAttemptPrompt({
        attempt: { sessionId },
        activeSession: session,
        contextTokenBudget: promptContext.contextTokenBudget,
        images: [],
        modelPrompt: promptContext.promptForModel,
        onFinalPromptText: () => {},
        onSteeringAcknowledged: () => {},
        persistToolResultProjections: async () => {},
        promptActiveSession: (text, options) => session.prompt(text, options),
        runtimeOnly: false,
        sessionPromptState,
        systemPrompt: "",
        toolResultAggregateMaxChars: promptContext.promptToolResultAggregateMaxChars,
        toolResultMaxChars: promptContext.promptToolResultMaxChars,
        toolResultPromptProjectionState: sessionPromptState.toolResults,
        trajectoryRecorder: null,
        transcriptLeafId: null,
        transcriptPrompt: promptContext.promptForSession,
      });

      const redacted = modelRequests.map((messages) => redactedModelRequestSummary(messages));
      expect(redacted).toEqual([
        [
          { role: "user", text: "Summary of accepted history." },
          { role: "user", text: prompt },
        ],
        [
          { role: "user", text: "Summary of accepted history." },
          { role: "user", text: prompt },
          { role: "assistant", hasToolCall: true },
          { role: "toolResult", toolCallId: "call-1" },
        ],
        [
          { role: "user", text: "Summary of accepted history." },
          { role: "user", text: prompt },
          { role: "assistant", hasToolCall: true },
          { role: "toolResult", toolCallId: "call-1" },
          { role: "assistant", hasToolCall: true },
          { role: "toolResult", toolCallId: "call-2" },
        ],
      ]);
      expect(modelRequests).toHaveLength(3);
      expect(toolCalls).toBe(2);
    } finally {
      guards.remove();
      clearEmbeddedSessionPromptStates([sessionId]);
    }
  });
});
