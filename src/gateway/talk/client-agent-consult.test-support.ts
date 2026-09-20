import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginRuntime } from "../../plugins/runtime/types.js";

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export function createCoreParams(config: OpenClawConfig) {
  return {
    config,
    prompt: "check",
    runId: "run-talk",
    sessionId: "session-talk",
    sessionTarget: {
      agentId: "researcher",
      sessionId: "session-talk",
      sessionKey: "agent:researcher:talk",
      storePath: "/tmp/sessions",
    },
    timeoutMs: 1,
    workspaceDir: "/tmp/workspace",
  } as Parameters<PluginRuntime["agent"]["runEmbeddedAgent"]>[0];
}
