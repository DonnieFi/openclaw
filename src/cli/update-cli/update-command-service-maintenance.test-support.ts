import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { buildTaskScript } from "../../daemon/schtasks-layout.js";
import type { GatewayServiceCommandConfig } from "../../daemon/service-types.js";
import type { GatewayService } from "../../daemon/service.js";
import { mockSystemAccountHome } from "../../daemon/service.test-helpers.js";
import * as openClawTmp from "../../infra/tmp-openclaw-dir.js";
import { resolveManagedUpdateLeaseDatabasePath } from "../../infra/update-managed-service-handoff-lease.js";
import { makeTempWorkspace } from "../../test-helpers/workspace.js";
import { withEnvAsync } from "../../test-utils/env.js";

const mocks = vi.hoisted(() => ({
  service: vi.fn<() => GatewayService>(),
  prepareStop:
    vi.fn<typeof import("../../daemon/systemd-maintenance.js").prepareSystemdGatewayMaintenance>(),
  drain: vi.fn(
    async (
      _params: Parameters<
        typeof import("./update-command-service-drain.js").withGatewayMaintenanceDrain
      >[0],
      stop: () => Promise<void>,
    ) => await stop(),
  ),
  taskState: 3 as number | string,
  taskScriptPath: "C:\\Fixture\\gateway.cmd",
}));

export { mocks };

vi.mock("./update-command-service-drain.js", () => ({
  withGatewayMaintenanceDrain: mocks.drain,
}));

vi.mock("../../daemon/systemd-maintenance.js", () => ({
  prepareSystemdGatewayMaintenance: mocks.prepareStop,
}));

vi.mock("../../daemon/service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/service.js")>()),
  resolveGatewayService: mocks.service,
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawnSync: vi.fn(() => ({
    pid: 0,
    output: [null, JSON.stringify({ state: mocks.taskState, lastRunResult: 0 }), ""],
    stdout: JSON.stringify({
      taskPath: "\\OpenClaw Gateway",
      state: mocks.taskState,
      lastRunResult: 0,
      actions: [{ type: 0, path: mocks.taskScriptPath, arguments: "", workingDirectory: "" }],
    }),
    stderr: "",
    status: 0,
    signal: null,
  })),
}));

beforeEach(() => {
  mockSystemAccountHome();
  mocks.prepareStop.mockReset().mockResolvedValue(false);
  mocks.drain.mockReset().mockImplementation(async (_params, stop) => await stop());
});
afterEach(() => vi.restoreAllMocks());

export function mockRegisteredWindowsLauncher(home: string): GatewayServiceCommandConfig {
  const command = {
    programArguments: [process.execPath, path.join(process.cwd(), "openclaw.mjs"), "gateway"],
    environment: { HOME: home },
    sourcePath: mocks.taskScriptPath,
  };
  const script = Buffer.from(buildTaskScript(command));
  const readFile = fs.readFile;
  vi.spyOn(fs, "readFile").mockImplementation(async (pathname, options) =>
    pathname === mocks.taskScriptPath ? script : readFile(pathname, options),
  );
  return command;
}

export async function withServiceHome(run: (home: string) => Promise<void>): Promise<void> {
  const home = await fs.realpath(await makeTempWorkspace("openclaw-update-service-"));
  const tempRoot = vi.spyOn(openClawTmp, "resolvePreferredOpenClawTmpDir").mockReturnValue(home);
  try {
    // Verify the actual resolver and its filesystem alias before any helper opens SQLite.
    const databasePath = resolveManagedUpdateLeaseDatabasePath();
    expect(databasePath).toBe(path.join(home, "managed-update-handoffs.sqlite"));
    expect(await fs.realpath(path.dirname(databasePath))).toBe(home);
    await withEnvAsync(
      {
        HOME: home,
        USERPROFILE: home,
        APPDATA: path.join(home, "AppData"),
        OPENCLAW_GATEWAY_PORT: undefined,
        OPENCLAW_HOME: undefined,
        OPENCLAW_STATE_DIR: undefined,
        OPENCLAW_CONFIG_PATH: undefined,
        OPENCLAW_PROFILE: undefined,
        OPENCLAW_SUPERVISOR_MODE: undefined,
        OPENCLAW_SERVICE_MARKER: undefined,
        OPENCLAW_SERVICE_KIND: undefined,
      },
      () => run(home),
    );
  } finally {
    tempRoot.mockRestore();
    await fs.rm(home, { recursive: true, force: true });
  }
}
