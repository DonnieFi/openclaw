import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { run, type CommandRecord } from "./schtasks.installed-command.test-support.js";

const temporary = useAutoCleanupTempDirTracker(afterEach);

it.each([false, true])(
  "retains sanitized stdout JSON with a colored label=%s",
  async (coloredLabel) => {
    const root = temporary.make("schtasks-command-output-");
    const secret = "synthetic-fixture-credential-do-not-report";
    const records: CommandRecord[] = [];
    const env = {
      SystemRoot: process.env.SystemRoot,
      WINDIR: process.env.WINDIR,
      HOME: root,
      USERPROFILE: root,
      OPENCLAW_STATE_DIR: path.join(root, "state"),
      FIXTURE_SECRET: secret,
      FIXTURE_COLORED_LABEL: coloredLabel ? "1" : "0",
    };
    const args = [
      "-e",
      `
    process.stdout.write("\\x1b[31m" + JSON.stringify({
      padding: "x".repeat(4000),
      action: "install", ok: false, token: process.env.FIXTURE_SECRET,
      error: "Synthetic install refusal; inspect the registered task."
    }) + "\\x1b[0m");
    if (process.env.FIXTURE_COLORED_LABEL === "1") {
      process.stdout.write("\\n\\x1b[31mtoken\\x1b[0m=" + process.env.FIXTURE_SECRET);
    }
    process.exitCode = 7;
  `,
    ];
    let failure: unknown;
    try {
      await run(args, env, root, records);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toContain("Synthetic install refusal");
    expect(String(failure)).not.toContain(secret);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      code: 7,
      signal: null,
      beforeCleanup: "dead",
      joined: true,
      failureOutput: { stderr: "", captureTruncated: false },
    });
    const output = records[0]?.failureOutput?.stdout;
    expect(output).toContain('"action":"install"');
    expect(output).toContain("Synthetic install refusal");
    expect(output).not.toContain(secret);
    expect(output).not.toContain("\x1b");
    expect(output?.length).toBeLessThanOrEqual(2002);
  },
);

it("withholds incomplete captures while preserving the truncation failure", async () => {
  const root = temporary.make("schtasks-command-truncated-");
  const records: CommandRecord[] = [];
  await expect(
    run(
      [
        "-e",
        'process.stdout.write("x".repeat(262144) + "incomplete-fixture-output"); process.exitCode = 7;',
      ],
      { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR },
      root,
      records,
    ),
  ).rejects.toThrow("Command output was truncated");
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({
    code: 7,
    signal: null,
    beforeCleanup: "dead",
    joined: true,
    failureOutput: {
      stdout: "[output withheld: capture limit exceeded]",
      stderr: "[output withheld: capture limit exceeded]",
      captureTruncated: true,
    },
  });
});

it("keeps an expected nonzero exit successful without retaining its raw output", async () => {
  const root = temporary.make("schtasks-command-expected-");
  const records: CommandRecord[] = [];
  const output = await run(
    ["-e", 'process.stdout.write("expected findings"); process.exitCode = 1;'],
    { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR },
    root,
    records,
    1,
  );
  expect(output).toBe("expected findings");
  expect(records).toHaveLength(1);
  expect(records[0]?.code).toBe(1);
  expect(records[0]).not.toHaveProperty("failureOutput");
});
