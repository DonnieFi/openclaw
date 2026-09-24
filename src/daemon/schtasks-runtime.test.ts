import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  isScheduledTaskDefinitelyNotRunning,
  readScheduledTaskRuntime,
  waitForScheduledTaskRunningEvidence,
} from "./schtasks-runtime.js";
import { probeScheduledTaskExists } from "./schtasks-state-probe.js";

const schtasksResponses = vi.hoisted(
  (): Array<{ code: number; stdout: string; stderr: string }> => [],
);
const spawnSync = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async () => ({
  ...(await vi.importActual<typeof import("node:child_process")>("node:child_process")),
  spawnSync,
}));

vi.mock("./schtasks-exec.js", () => ({
  execSchtasks: async () => schtasksResponses.shift() ?? { code: 0, stdout: "", stderr: "" },
}));

vi.mock("./gateway-service-probe-hosts.js", () => ({
  resolveGatewayServiceProbeHosts: async () => ["127.0.0.1"],
}));

beforeEach(() => {
  schtasksResponses.length = 0;
  spawnSync.mockReset();
});

describe("scheduled task runtime derivation", () => {
  async function readRuntimeFromQueryOutput(output: string) {
    schtasksResponses.push(
      { code: 0, stdout: "", stderr: "" },
      { code: 0, stdout: output, stderr: "" },
    );
    return await readScheduledTaskRuntime({
      USERPROFILE: "C:\\Users\\test",
      OPENCLAW_PROFILE: "default",
    });
  }

  it.each([
    { state: 3, result: 0, expected: "stopped", label: "Bereit" },
    { state: 4, result: 0, expected: "running", label: "Wird ausgeführt" },
    { state: 2, result: 0, expected: "unknown", label: "In Warteschlange" },
    { state: 0, result: 0, expected: "unknown", label: "Unbekannt" },
  ])("uses numeric task state $state on a fully localized Windows host", async (task) => {
    spawnSync.mockReturnValue({
      status: 0,
      stdout: JSON.stringify({
        state: task.state,
        lastRunResult: task.result,
        lastRunTime: "2026-08-02T12:00:00.0000000Z",
      }),
      stderr: "",
    });
    const runtime = await readRuntimeFromQueryOutput(
      [
        "Aufgabenname: \\OpenClaw Gateway",
        `Status: ${task.label}`,
        "Letzte Laufzeit: 02.08.2026 14:00:00",
        "Letztes Ergebnis: 0",
      ].join("\r\n"),
    );
    expect(runtime.status).toBe(task.expected);
  });

  it.each([
    { state: 1, result: 267009, expected: "stopped", name: "Disabled" },
    { state: 3, result: 267009, expected: "stopped", name: "Ready" },
    { state: 4, result: -2147024891, expected: "running", name: "Running" },
    { state: 2, result: 0, expected: "unknown", name: "Queued" },
    { state: 0, result: 267009, expected: "unknown", name: "Unknown" },
  ])("uses $name rather than stale last-run result $result", async (task) => {
    spawnSync.mockReturnValue({
      status: 0,
      stdout: JSON.stringify({ state: task.state, lastRunResult: task.result }),
    });
    await expect(readRuntimeFromQueryOutput("")).resolves.toMatchObject({
      status: task.expected,
      state: task.name,
      lastRunResult: String(task.result),
    });
    expect(probeScheduledTaskExists("OpenClaw Gateway")).toBe(true);
    expect(isScheduledTaskDefinitelyNotRunning("OpenClaw Gateway")).toBe(
      task.expected === "stopped",
    );
  });

  it.each([
    { state: 3 },
    { state: 3, lastRunResult: null, lastRunTime: null },
    { state: 3, lastRunResult: "unavailable", lastRunTime: false },
  ])("preserves task state and existence without optional history: %j", async (snapshot) => {
    spawnSync.mockReturnValue({ status: 0, stdout: JSON.stringify(snapshot) });
    await expect(readRuntimeFromQueryOutput("")).resolves.toMatchObject({
      status: "stopped",
      state: "Ready",
    });
    expect(probeScheduledTaskExists("OpenClaw Gateway")).toBe(true);
    expect(isScheduledTaskDefinitelyNotRunning("OpenClaw Gateway")).toBe(true);
  });

  it.each([null, "3", 5])(
    "preserves existence but not offline proof for state %j",
    async (state) => {
      spawnSync.mockReturnValue({ status: 0, stdout: JSON.stringify({ state }) });
      await expect(readRuntimeFromQueryOutput("")).resolves.toMatchObject({ status: "unknown" });
      expect(probeScheduledTaskExists("OpenClaw Gateway")).toBe(true);
      expect(isScheduledTaskDefinitelyNotRunning("OpenClaw Gateway")).toBe(false);
    },
  );

  it.each(["-2147024894", "-2147024893"])(
    "recognizes lookup HRESULT %s as missing",
    async (stdout) => {
      spawnSync.mockReturnValue({ status: 1, stdout });
      await expect(readRuntimeFromQueryOutput("")).resolves.toEqual({
        status: "stopped",
        missingUnit: true,
      });
      expect(probeScheduledTaskExists("OpenClaw Gateway")).toBe(false);
      expect(isScheduledTaskDefinitelyNotRunning("OpenClaw Gateway")).toBe(false);
    },
  );

  it.each([
    { name: "access denied", status: 1, stdout: "-2147024891" },
    { name: "COM activation missing", status: 2, stdout: "-2147221164" },
    { name: "connection missing file", status: 2, stdout: "-2147024894" },
    { name: "malformed HRESULT", status: 1, stdout: "-2147024894 trailing" },
    { name: "invalid JSON", status: 0, stdout: "not JSON" },
    { name: "non-object JSON", status: 0, stdout: "null" },
    { name: "spawn failure", status: null, stdout: "", error: new Error("ENOENT") },
    { name: "timeout", status: null, stdout: "", error: new Error("ETIMEDOUT") },
  ])("keeps $name unavailable, not missing or stopped", async (response) => {
    spawnSync.mockReturnValue(response);
    await expect(readRuntimeFromQueryOutput("")).resolves.toMatchObject({
      status: "unknown",
      missingUnit: false,
      inspectionFailure: { code: "service-runtime-inspection-failed" },
    });
    expect(probeScheduledTaskExists("OpenClaw Gateway")).toBeNull();
  });

  it("requires current Scheduler running state before retiring the Startup owner", async () => {
    spawnSync
      .mockReturnValueOnce({
        status: 0,
        stdout: JSON.stringify({ state: 3, lastRunResult: 267009 }),
      })
      .mockReturnValueOnce({ status: 0, stdout: JSON.stringify({ state: 4, lastRunResult: 0 }) });
    await expect(waitForScheduledTaskRunningEvidence({})).resolves.toBe(true);
    expect(spawnSync).toHaveBeenCalledTimes(2);
  });
});
