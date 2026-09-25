import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { sanitizeForLog, stripAnsi } from "../../packages/terminal-core/src/ansi.js";
import {
  hasUnjoinedWork,
  inspectManagedProcessGroup,
  runManagedCommand,
} from "../../scripts/lib/managed-child-process.mts";
import { redactSupportString } from "../logging/diagnostic-support-redaction.js";
import { formatCommandOutput } from "../process/command-error.js";

export type CommandRecord = {
  args: string[];
  launcherPid: number | null;
  beforeCleanup: ReturnType<typeof inspectManagedProcessGroup> | undefined;
  code: number | null;
  signal: string | null;
  joined: boolean;
  elapsedMs: number;
  failureOutput?: { stdout: string; stderr: string; captureTruncated: boolean };
};
export async function run(
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
  records: CommandRecord[],
  expectedExit = 0,
  signal?: AbortSignal,
  expectedStderr: readonly string[] = [],
) {
  const started = performance.now();
  let child: ChildProcess | undefined;
  let stdout = "";
  let stderr = "";
  let truncated = false;
  let code: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;
  let beforeCleanup: ReturnType<typeof inspectManagedProcessGroup> | undefined;
  let result: number | undefined;
  let failure: Error | undefined;
  try {
    result = await runManagedCommand({
      bin: process.execPath,
      args,
      env,
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      timeoutMs: 180_000,
      signal,
      onReady(launched) {
        child = launched;
        launched.stdout?.on("data", (chunk: Buffer) => {
          stdout += chunk.toString();
          if (stdout.length > 262144) {
            truncated = true;
            stdout = stdout.slice(-262144);
          }
        });
        launched.stderr?.on("data", (chunk: Buffer) => {
          stderr += chunk.toString();
          if (stderr.length > 262144) {
            truncated = true;
            stderr = stderr.slice(-262144);
          }
        });
        launched.once("exit", (exitCode, receivedSignal) => {
          code = exitCode;
          exitSignal = receivedSignal;
          beforeCleanup = inspectManagedProcessGroup(launched, { errorPolicy: "indeterminate" });
        });
      },
    });
  } catch (error) {
    failure = toErrorObject(error, "Installed Scheduled Task fixture failed");
  }
  const afterCleanup = child
    ? inspectManagedProcessGroup(child, { errorPolicy: "indeterminate" })
    : undefined;
  const stderrMatches = expectedStderr.every((expected) => stderr.includes(expected));
  const failed =
    failure ||
    afterCleanup !== "dead" ||
    beforeCleanup !== "dead" ||
    truncated ||
    exitSignal !== null ||
    code !== expectedExit ||
    result !== expectedExit ||
    !stderrMatches;
  const redaction = { env, stateDir: env.OPENCLAW_STATE_DIR ?? cwd };
  const diagnostic = (value: string) => {
    // A truncated capture may have lost the field name needed for redaction.
    if (truncated) {
      return "[output withheld: capture limit exceeded]";
    }
    const normalized = stripAnsi(value)
      .split(/\r\n|[\r\n]/u)
      .map((line) => sanitizeForLog(line.replaceAll("\t", " ")))
      .join("\n");
    return formatCommandOutput(
      redactSupportString(normalized, redaction, { maxLength: Number.MAX_SAFE_INTEGER }),
      2_000,
    );
  };
  const failureOutput = failed
    ? {
        stdout: diagnostic(stdout),
        stderr: diagnostic(stderr),
        captureTruncated: truncated,
      }
    : undefined;
  records.push({
    args,
    launcherPid: child?.pid ?? null,
    code,
    signal: exitSignal,
    beforeCleanup,
    joined: afterCleanup === "dead" && !hasUnjoinedWork(failure),
    elapsedMs: performance.now() - started,
    ...(failureOutput ? { failureOutput } : {}),
  });
  if (child && afterCleanup !== "dead") {
    // Keep the existing fixture lifetime's claim when physical cleanup is uncertain.
    throw Object.assign(
      new Error("Installed command descendant cleanup is unverified", { cause: failure }),
      {
        processTreeState: "indeterminate",
      },
    );
  }
  if (failure) {
    throw failure;
  }
  assert.equal(beforeCleanup, "dead", "Installed command required descendant cleanup after exit");
  assert.equal(truncated, false, "Command output was truncated");
  assert.equal(exitSignal, null);
  const details = failureOutput ? JSON.stringify(failureOutput, null, 2) : "";
  assert.equal(code, expectedExit, details);
  assert.equal(result, expectedExit, details);
  assert.equal(
    stderrMatches,
    true,
    `Command stderr did not match expected diagnostics.\n${details}`,
  );
  return stdout;
}
