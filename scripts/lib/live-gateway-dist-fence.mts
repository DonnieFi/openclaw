// Refuse dist mutation while a managed Gateway still runs from this checkout's dist.
import path from "node:path";
import {
  gatewayServiceCommandMatchesRoot,
  resolveServiceEntrypoint,
} from "../../src/daemon/service-layout.ts";
import type { GatewayServiceEnv, GatewayServiceState } from "../../src/daemon/service-types.ts";
import { readGatewayServiceState, resolveGatewayService } from "../../src/daemon/service.ts";

export type LiveGatewayDistFenceDeps = {
  env?: NodeJS.ProcessEnv;
  readState?: () => Promise<GatewayServiceState>;
  matchesRoot?: (root: string, command: GatewayServiceState["command"]) => Promise<boolean | null>;
  isPidAlive?: (pid: number) => boolean;
};

export type LiveGatewayDistFenceResult = { refuse: true; message: string } | { refuse: false };

const ALLOW_ENV = "OPENCLAW_ALLOW_LIVE_DIST_BUILD";

function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** True when the managed service still holds a live process on this checkout's dist. */
export function isLiveManagedGatewayHoldingDist(
  state: GatewayServiceState,
  options: { isPidAlive?: (pid: number) => boolean } = {},
): boolean {
  if (state.running) {
    return true;
  }
  const isPidAlive = options.isPidAlive ?? defaultIsPidAlive;
  const pid = state.runtime?.pid;
  if (typeof pid === "number" && Number.isSafeInteger(pid) && pid > 1 && isPidAlive(pid)) {
    return true;
  }
  const status = state.runtime?.status?.toLowerCase() ?? "";
  const subState = state.runtime?.subState?.toLowerCase() ?? "";
  // systemd stop/restart drains keep MainPID alive under deactivating states.
  return (
    status === "deactivating" ||
    subState === "stop-sigterm" ||
    subState === "stop-sigkill" ||
    subState === "final-sigterm"
  );
}

function formatRefuseMessage(params: { entrypoint?: string; unit?: string }): string {
  const entry = params.entrypoint ? ` (${params.entrypoint})` : "";
  const unit = params.unit ? ` unit ${params.unit}` : "";
  return (
    `[openclaw] Refusing to rebuild dist while a managed Gateway${unit} is still running from this checkout's dist${entry}. ` +
    "Stop the Gateway first (`openclaw gateway stop` or the matching service stop), rebuild, then start. " +
    `Set ${ALLOW_ENV}=1 only for intentional live mutations.`
  );
}

/**
 * Returns a refuse decision when a managed Gateway ExecStart resolves into
 * `checkoutRoot` and the service still holds a live process.
 */
export async function resolveLiveManagedGatewayDistFence(
  checkoutRoot: string,
  deps: LiveGatewayDistFenceDeps = {},
): Promise<LiveGatewayDistFenceResult> {
  const env = deps.env ?? process.env;
  if (env[ALLOW_ENV] === "1") {
    return { refuse: false };
  }

  const readState =
    deps.readState ??
    (async () =>
      await readGatewayServiceState(resolveGatewayService(), {
        env: env as GatewayServiceEnv,
      }));
  const matchesRoot =
    deps.matchesRoot ?? ((root, command) => gatewayServiceCommandMatchesRoot(root, command));

  let state: GatewayServiceState;
  try {
    state = await readState();
  } catch {
    // Hosts without a managed service, or inspection failures, must not block
    // ordinary builds. Only a positive live match refuses.
    return { refuse: false };
  }

  const root = path.resolve(checkoutRoot);
  let matches: boolean | null;
  try {
    matches = await matchesRoot(root, state.command);
  } catch {
    return { refuse: false };
  }
  if (matches !== true) {
    return { refuse: false };
  }
  if (!isLiveManagedGatewayHoldingDist(state, { isPidAlive: deps.isPidAlive })) {
    return { refuse: false };
  }

  return {
    refuse: true,
    message: formatRefuseMessage({
      checkoutRoot: root,
      ...(state.command ? { entrypoint: resolveServiceEntrypoint(state.command) } : {}),
      ...(state.runtime?.systemd?.unit ? { unit: state.runtime.systemd.unit } : {}),
    }),
  };
}
