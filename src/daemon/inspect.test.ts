// Daemon inspect tests cover service inspection and diagnostic output.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  detectMarkerLineWithGateway,
  findExtraGatewayServices,
  renderGatewayServiceCleanupHints,
} from "./inspect.js";

const { listScheduledTasksMock, readScheduledTaskCommandMock } = vi.hoisted(() => ({
  listScheduledTasksMock: vi.fn<typeof import("./schtasks-state-probe.js").listScheduledTasks>(),
  readScheduledTaskCommandMock:
    vi.fn<typeof import("./schtasks-layout.js").readScheduledTaskCommand>(),
}));

vi.mock("./schtasks-state-probe.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./schtasks-state-probe.js")>()),
  listScheduledTasks: listScheduledTasksMock,
}));
vi.mock("./schtasks-layout.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./schtasks-layout.js")>()),
  readScheduledTaskCommand: readScheduledTaskCommandMock,
}));

const nativePlistHost = vi.hoisted(() => process.platform === "darwin");
vi.mock("../process/exec.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../process/exec.js")>();
  const { decodeLaunchAgentPlistFixture } = await import("./launchd-plist.test-support.js");
  return {
    ...actual,
    runExec: vi.fn(async (...args: Parameters<typeof actual.runExec>) => {
      if (nativePlistHost) {
        return actual.runExec(...args);
      }
      const options = args[2];
      const input = typeof options === "object" ? options.input : undefined;
      if (input === undefined) {
        throw new Error("Native parser requires captured plist bytes");
      }
      return decodeLaunchAgentPlistFixture(input, args[1][1]);
    }),
  };
});

// File-scope cleanup cannot prevent the nested platform-restoration hooks from running.
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

// Real content from the openclaw-gateway.service unit file (the canonical gateway unit).
const GATEWAY_SERVICE_CONTENTS = `\
[Unit]
Description=OpenClaw Gateway
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/bin/node /home/openclaw/.npm-global/lib/node_modules/openclaw/dist/entry.js gateway --port 18789
Restart=always
Environment=OPENCLAW_SERVICE_MARKER=openclaw
Environment=OPENCLAW_SERVICE_KIND=gateway

[Install]
WantedBy=default.target
`;

// Real content from the openclaw-test.service unit file (a non-gateway openclaw service).
const TEST_SERVICE_CONTENTS = `\
[Unit]
Description=OpenClaw test service
After=default.target

[Service]
Type=simple
ExecStart=/bin/sh -c 'while true; do sleep 60; done'
Restart=on-failure

[Install]
WantedBy=default.target
`;

const CLAWDBOT_GATEWAY_CONTENTS = `\
[Unit]
Description=Clawdbot Gateway
[Service]
ExecStart=/usr/bin/node /opt/clawdbot/dist/entry.js gateway --port 18789
Environment=HOME=/home/clawdbot
`;

const COMPANION_SERVICE_CONTENTS = `\
[Unit]
Description=OpenClaw companion worker
After=openclaw-gateway.service
Requires=openclaw-gateway.service

[Service]
ExecStart=/usr/bin/node /opt/openclaw-worker/dist/index.js worker
`;

const CUSTOM_OPENCLAW_GATEWAY_CONTENTS = `\
[Unit]
Description=Custom OpenClaw gateway

[Service]
ExecStart=/usr/bin/node /opt/openclaw/dist/entry.js gateway --port 18888
`;

describe("detectMarkerLineWithGateway", () => {
  it("returns null for openclaw-test.service (openclaw only in description, no gateway on same line)", () => {
    expect(detectMarkerLineWithGateway(TEST_SERVICE_CONTENTS)).toBeNull();
  });

  it("returns openclaw for the canonical gateway unit (ExecStart has both openclaw and gateway)", () => {
    expect(detectMarkerLineWithGateway(GATEWAY_SERVICE_CONTENTS)).toBe("openclaw");
  });

  it("returns clawdbot for a clawdbot gateway unit", () => {
    expect(detectMarkerLineWithGateway(CLAWDBOT_GATEWAY_CONTENTS)).toBe("clawdbot");
  });

  it.each([
    "ExecStart=/usr/bin/openclaw \\\n  gateway",
    "# comment \\\nExecStart=/usr/bin/openclaw gateway",
    "; comment \\\nExecStart=/usr/bin/openclaw gateway",
    "ExecStart=/usr/bin/openclaw \\\n# comment\n  gateway",
  ])("detects commands through native comments and continuations: %s", (command) => {
    expect(detectMarkerLineWithGateway(`[Service]\n${command}\n`)).toBe("openclaw");
  });

  it.each(["After", "Requires", "Description", "Environment"])(
    "ignores gateway mentions in %s instead of an executable directive",
    (key) => {
      expect(detectMarkerLineWithGateway(`${key}=openclaw gateway\n`)).toBeNull();
    },
  );

  it("ignores dependency-only references to the gateway unit", () => {
    expect(detectMarkerLineWithGateway(COMPANION_SERVICE_CONTENTS)).toBeNull();
  });

  it("ignores non-gateway ExecStart commands that only pass gateway-named options", () => {
    const contents = `[Service]\nExecStart=/usr/bin/openclaw-helper --gateway-url http://127.0.0.1:18789 sync\n`;
    expect(detectMarkerLineWithGateway(contents)).toBeNull();
  });
});

describe("renderGatewayServiceCleanupHints", () => {
  it("does not suggest removing a gateway when no extra service was detected", () => {
    expect(renderGatewayServiceCleanupHints([])).toEqual([]);
  });

  it.each([
    {
      title: "targets the detected macOS LaunchAgent instead of the active gateway",
      platform: "darwin",
      serviceName: "com.example.openclaw-gateway",
      source: "plist: /Users/test/Library/LaunchAgents/com.example.openclaw-gateway.plist",
      scope: "user",
      firstHint: "launchctl bootout gui/$UID/com.example.openclaw-gateway",
      secondHint: "rm /Users/test/Library/LaunchAgents/com.example.openclaw-gateway.plist",
    },
    {
      title: "uses the system domain for a detected macOS LaunchDaemon",
      platform: "darwin",
      serviceName: "com.example.openclaw-gateway",
      source: "plist: /Library/LaunchDaemons/com.example.openclaw-gateway.plist",
      scope: "system",
      firstHint: "sudo launchctl bootout system/com.example.openclaw-gateway",
      secondHint: "sudo rm /Library/LaunchDaemons/com.example.openclaw-gateway.plist",
    },
    {
      title: "keeps global macOS LaunchAgents in the GUI domain",
      platform: "darwin",
      serviceName: "com.example.openclaw-gateway",
      source: "plist: /Library/LaunchAgents/com.example.openclaw-gateway.plist",
      scope: "system",
      firstHint: "launchctl bootout gui/$UID/com.example.openclaw-gateway",
      secondHint: "sudo rm /Library/LaunchAgents/com.example.openclaw-gateway.plist",
    },
    {
      title: "inspects the detected user-level systemd unit without removing it",
      platform: "linux",
      serviceName: "custom-gateway.service",
      source: "unit: /home/test/.config/systemd/user/custom-gateway.service",
      scope: "user",
      firstHint: "systemctl --user status -- custom-gateway.service",
      secondHint: "systemctl --user cat -- custom-gateway.service",
    },
    {
      title: "inspects the detected system-level systemd unit without removing it",
      platform: "linux",
      serviceName: "custom-gateway.service",
      source: "unit: /etc/systemd/system/custom-gateway.service",
      scope: "system",
      firstHint: "systemctl --system status -- custom-gateway.service",
      secondHint: "systemctl --system cat -- custom-gateway.service",
    },
    {
      title: "terminates systemctl options before a detected unit that begins with a dash",
      platform: "linux",
      serviceName: "-custom-gateway.service",
      source: "unit: /home/test/.config/systemd/user/-custom-gateway.service",
      scope: "user",
      firstHint: "systemctl --user status -- -custom-gateway.service",
      secondHint: "systemctl --user cat -- -custom-gateway.service",
    },
    {
      title: "shell-quotes detected POSIX service labels and paths",
      platform: "darwin",
      serviceName: "com.example.gateway; touch injected",
      source: "plist: /Users/test/Launch Agents/example's gateway.plist",
      scope: "user",
      firstHint: "launchctl bootout gui/$UID/'com.example.gateway; touch injected'",
      secondHint: "rm '/Users/test/Launch Agents/example'\\''s gateway.plist'",
    },
  ] as const)("$title", ({ platform, serviceName, source, scope, firstHint, secondHint }) => {
    expect(
      renderGatewayServiceCleanupHints([
        {
          platform,
          label: serviceName,
          detail: source,
          scope,
        },
      ]),
    ).toEqual([firstHint, secondHint]);
  });

  it("targets the detected Windows scheduled task", () => {
    expect(
      renderGatewayServiceCleanupHints([
        {
          platform: "win32",
          label: "\\OpenClaw Gateway Backup",
          detail: "task: \\OpenClaw Gateway Backup",
          scope: "system",
        },
      ]),
    ).toEqual(['schtasks /Delete /TN "\\OpenClaw Gateway Backup" /F']);
  });

  it.each(["$(Start-Process calc)", "%OPENCLAW_GATEWAY_TASK%", "unsafe&task", "task`name"])(
    "does not render a Windows task name expandable by cmd.exe or PowerShell: %s",
    (label) => {
      expect(
        renderGatewayServiceCleanupHints([
          {
            platform: "win32",
            label,
            detail: `task: ${label}`,
            scope: "system",
          },
        ]),
      ).toEqual([]);
    },
  );

  it("does not invent a removal path when service metadata omits it", () => {
    expect(
      renderGatewayServiceCleanupHints([
        {
          platform: "darwin",
          label: "com.example.openclaw-gateway",
          detail: "loaded",
          scope: "user",
        },
      ]),
    ).toEqual(["launchctl bootout gui/$UID/com.example.openclaw-gateway"]);
  });
});

describe("findExtraGatewayServices (linux / scanSystemdDir) — real filesystem", () => {
  // These tests write real .service files to a temp dir and call findExtraGatewayServices
  // with that dir as HOME. No platform mocking or fs mocking needed.
  const isLinux = process.platform === "linux";

  it.skipIf(!isLinux)("does not report openclaw-test.service as a gateway service", async () => {
    const tmpHome = tempDirs.make("openclaw-test-", os.tmpdir());
    const systemdDir = path.join(tmpHome, ".config", "systemd", "user");
    await fs.mkdir(systemdDir, { recursive: true });
    await fs.writeFile(path.join(systemdDir, "openclaw-test.service"), TEST_SERVICE_CONTENTS);
    const result = await findExtraGatewayServices({ HOME: tmpHome });
    expect(result).toStrictEqual({ services: [], errors: [] });
  });

  it.skipIf(!isLinux)(
    "does not report the canonical openclaw-gateway.service as an extra service",
    async () => {
      const tmpHome = tempDirs.make("openclaw-test-", os.tmpdir());
      const systemdDir = path.join(tmpHome, ".config", "systemd", "user");
      await fs.mkdir(systemdDir, { recursive: true });
      await fs.writeFile(
        path.join(systemdDir, "openclaw-gateway.service"),
        GATEWAY_SERVICE_CONTENTS,
      );
      const result = await findExtraGatewayServices({ HOME: tmpHome });
      expect(result).toStrictEqual({ services: [], errors: [] });
    },
  );

  it.skipIf(!isLinux)(
    "reports a legacy clawdbot-gateway service as an extra gateway service",
    async () => {
      const tmpHome = tempDirs.make("openclaw-test-", os.tmpdir());
      const systemdDir = path.join(tmpHome, ".config", "systemd", "user");
      const unitPath = path.join(systemdDir, "clawdbot-gateway.service");
      await fs.mkdir(systemdDir, { recursive: true });
      await fs.writeFile(unitPath, CLAWDBOT_GATEWAY_CONTENTS);
      const result = await findExtraGatewayServices({ HOME: tmpHome });
      expect(result.services).toEqual([
        {
          platform: "linux",
          label: "clawdbot-gateway.service",
          detail: `unit: ${unitPath}`,
          scope: "user",
          marker: "clawdbot",
          legacy: true,
        },
      ]);
    },
  );

  it.skipIf(!isLinux)("reports an orphaned legacy systemd backup", async () => {
    const tmpHome = tempDirs.make("openclaw-test-", os.tmpdir());
    const systemdDir = path.join(tmpHome, ".config", "systemd", "user");
    const backupPath = path.join(systemdDir, "clawdbot-gateway.service.bak");
    await fs.mkdir(systemdDir, { recursive: true });
    await fs.writeFile(backupPath, CLAWDBOT_GATEWAY_CONTENTS);

    const result = await findExtraGatewayServices({ HOME: tmpHome });

    expect(result.services).toEqual([
      {
        platform: "linux",
        label: "clawdbot-gateway.service",
        detail: `unit backup: ${backupPath}`,
        scope: "user",
        marker: "clawdbot",
        legacy: true,
      },
    ]);
  });

  it.skipIf(!isLinux)("reports a legacy systemd unit and its backup once", async () => {
    const tmpHome = tempDirs.make("openclaw-test-", os.tmpdir());
    const systemdDir = path.join(tmpHome, ".config", "systemd", "user");
    const unitPath = path.join(systemdDir, "clawdbot-gateway.service");
    await fs.mkdir(systemdDir, { recursive: true });
    await fs.writeFile(unitPath, CLAWDBOT_GATEWAY_CONTENTS);
    await fs.writeFile(`${unitPath}.bak`, CLAWDBOT_GATEWAY_CONTENTS);

    const result = await findExtraGatewayServices({ HOME: tmpHome });

    expect(result.services).toEqual([
      {
        platform: "linux",
        label: "clawdbot-gateway.service",
        detail: `unit: ${unitPath}`,
        scope: "user",
        marker: "clawdbot",
        legacy: true,
      },
    ]);
  });

  it.skipIf(!isLinux)(
    "does not report companion units that only depend on the gateway",
    async () => {
      const tmpHome = tempDirs.make("openclaw-test-", os.tmpdir());
      const systemdDir = path.join(tmpHome, ".config", "systemd", "user");
      await fs.mkdir(systemdDir, { recursive: true });
      await fs.writeFile(
        path.join(systemdDir, "openclaw-companion.service"),
        COMPANION_SERVICE_CONTENTS,
      );
      const result = await findExtraGatewayServices({ HOME: tmpHome });
      expect(result).toStrictEqual({ services: [], errors: [] });
    },
  );

  it.skipIf(!isLinux).each(["", "# comment \\\n", "; comment \\\n"])(
    "reports custom-named gateway units after a physical comment: %j",
    async (comment) => {
      const tmpHome = tempDirs.make("openclaw-test-", os.tmpdir());
      const systemdDir = path.join(tmpHome, ".config", "systemd", "user");
      const unitPath = path.join(systemdDir, "custom-openclaw.service");
      await fs.mkdir(systemdDir, { recursive: true });
      await fs.writeFile(
        unitPath,
        CUSTOM_OPENCLAW_GATEWAY_CONTENTS.replace("ExecStart=", `${comment}ExecStart=`),
      );
      const result = await findExtraGatewayServices({ HOME: tmpHome });
      expect(result.services).toEqual([
        {
          platform: "linux",
          label: "custom-openclaw.service",
          detail: `unit: ${unitPath}`,
          scope: "user",
          marker: "openclaw",
          legacy: false,
        },
      ]);
    },
  );
});

describe("findExtraGatewayServices (darwin / scanLaunchdDir) — real filesystem", () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: "darwin",
    });
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: originalPlatform,
    });
  });

  it("does not report LaunchAgent companions that only mention the gateway label", async () => {
    const tmpHome = tempDirs.make("openclaw-test-", os.tmpdir());
    const launchdDir = path.join(tmpHome, "Library", "LaunchAgents");
    await fs.mkdir(launchdDir, { recursive: true });
    await fs.writeFile(
      path.join(launchdDir, "com.example.companion.plist"),
      `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>Label</key><string>com.example.companion</string>
<key>KeepAlive</key><dict><key>OtherJobEnabled</key><dict><key>ai.openclaw.gateway</key><true/></dict></dict>
<key>ProgramArguments</key><array><string>/usr/local/bin/openclaw-helper</string><string>sync</string></array>
</dict></plist>`,
    );
    const result = await findExtraGatewayServices({ HOME: tmpHome });
    expect(result).toStrictEqual({ services: [], errors: [] });
  });

  it("does not report LaunchAgent companions that only pass gateway-named options", async () => {
    const tmpHome = tempDirs.make("openclaw-test-", os.tmpdir());
    const launchdDir = path.join(tmpHome, "Library", "LaunchAgents");
    await fs.mkdir(launchdDir, { recursive: true });
    await fs.writeFile(
      path.join(launchdDir, "com.example.companion-options.plist"),
      `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>Label</key><string>com.example.companion-options</string>
<key>ProgramArguments</key><array><string>/usr/local/bin/openclaw-helper</string><string>--gateway-url</string><string>http://127.0.0.1:18789</string><string>sync</string></array>
</dict></plist>`,
    );
    const result = await findExtraGatewayServices({ HOME: tmpHome });
    expect(result).toStrictEqual({ services: [], errors: [] });
  });

  it("does not report non-gateway LaunchAgents that mention clawdbot in environment values", async () => {
    const tmpHome = tempDirs.make("openclaw-test-", os.tmpdir());
    const launchdDir = path.join(tmpHome, "Library", "LaunchAgents");
    await fs.mkdir(launchdDir, { recursive: true });
    await fs.writeFile(
      path.join(launchdDir, "com.github.facebook.watchman.plist"),
      `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>Label</key><string>com.github.facebook.watchman</string>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>/Users/test/Projects/clawdbot2/node_modules/.bin:/opt/homebrew/bin</string></dict>
<key>ProgramArguments</key><array><string>/opt/homebrew/bin/watchman</string><string>--foreground</string></array>
</dict></plist>`,
    );
    const result = await findExtraGatewayServices({ HOME: tmpHome });
    expect(result).toStrictEqual({ services: [], errors: [] });
  });

  it("reports a malformed recognizable plist without inventing a cleanup target", async () => {
    const tmpHome = tempDirs.make("openclaw-test-", os.tmpdir());
    const launchdDir = path.join(tmpHome, "Library", "LaunchAgents");
    const plistPath = path.join(launchdDir, "ai.openclaw.backup.plist");
    await fs.mkdir(launchdDir, { recursive: true });
    await fs.writeFile(plistPath, "not a plist");

    const result = await findExtraGatewayServices({ HOME: tmpHome });

    expect(result).toEqual({
      services: [],
      errors: [{ source: plistPath, message: expect.stringContaining("could not be inspected") }],
    });
    expect(renderGatewayServiceCleanupHints(result.services)).toEqual([]);
  });

  it("reports a service directory read failure as incomplete inspection", async () => {
    const tmpHome = tempDirs.make("openclaw-test-", os.tmpdir());
    const launchdDir = path.join(tmpHome, "Library", "LaunchAgents");
    await fs.mkdir(path.dirname(launchdDir), { recursive: true });
    await fs.writeFile(launchdDir, "not a directory");

    const result = await findExtraGatewayServices({ HOME: tmpHome });

    expect(result).toEqual({
      services: [],
      errors: [{ source: launchdDir, message: expect.stringContaining("could not be inspected") }],
    });
  });

  it("reports custom LaunchAgents that execute openclaw gateway", async () => {
    const tmpHome = tempDirs.make("openclaw-test-", os.tmpdir());
    const launchdDir = path.join(tmpHome, "Library", "LaunchAgents");
    const plistPath = path.join(launchdDir, "com.example.openclaw-gateway.plist");
    await fs.mkdir(launchdDir, { recursive: true });
    await fs.writeFile(
      plistPath,
      `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>Label</key><string>com.example.openclaw-gateway</string>
<key>ProgramArguments</key><array><string>/usr/local/bin/openclaw</string><string>gateway</string><string>--port</string><string>18888</string></array>
</dict></plist>`,
    );
    const result = await findExtraGatewayServices({ HOME: tmpHome });
    expect(result.services).toEqual([
      {
        platform: "darwin",
        label: "com.example.openclaw-gateway",
        detail: `plist: ${plistPath}`,
        scope: "user",
        marker: "openclaw",
        legacy: false,
      },
    ]);
    expect(renderGatewayServiceCleanupHints(result.services)).toEqual([
      "launchctl bootout gui/$UID/com.example.openclaw-gateway",
      `rm ${plistPath}`,
    ]);
  });
});

describe("Gateway inventory projections", () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
  });

  function isolateNativeRoots(home: string) {
    const roots = [
      "/etc/systemd/system",
      "/usr/lib/systemd/system",
      "/lib/systemd/system",
      "/Library/LaunchAgents",
      "/Library/LaunchDaemons",
    ].map((root) => path.normalize(root));
    const mapPath = (value: string) => {
      const normalized = path.normalize(value);
      return roots.some(
        (root) => normalized === root || normalized.startsWith(`${root}${path.sep}`),
      )
        ? path.join(home, "native", normalized.slice(path.parse(normalized).root.length))
        : value;
    };
    const readdir = fs.readdir;
    const readFile = fs.readFile;
    vi.spyOn(fs, "readdir").mockImplementation((...args: Parameters<typeof fs.readdir>) => {
      if (typeof args[0] === "string") {
        args[0] = mapPath(args[0]);
      }
      return readdir(...args);
    });
    vi.spyOn(fs, "readFile").mockImplementation((...args: Parameters<typeof fs.readFile>) => {
      if (typeof args[0] === "string") {
        args[0] = mapPath(args[0]);
      }
      return readFile(...args);
    });
    return async (file: string, contents: string) => {
      const target = mapPath(file);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, contents);
    };
  }

  it("filters managed systemd Gateways and authenticated Nodes while preserving extras and inspection errors", async () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "linux" });
    const home = tempDirs.make("managed-systemd-", os.tmpdir());
    const write = isolateNativeRoots(home);
    const userDir = path.join(home, ".config/systemd/user");
    for (const name of ["openclaw-gateway", "openclaw-gateway-dev", "rescue"]) {
      await write(path.join(userDir, `${name}.service`), CUSTOM_OPENCLAW_GATEWAY_CONTENTS);
    }
    await write("/etc/systemd/system/openclaw@.service", CUSTOM_OPENCLAW_GATEWAY_CONTENTS);
    await write("/usr/lib/systemd/system/vendor-gateway.service", CUSTOM_OPENCLAW_GATEWAY_CONTENTS);
    await write(
      path.join(userDir, "openclaw-node.service"),
      '[Service]\nExecStart=/usr/bin/openclaw node run\nEnvironment="OPENCLAW_SERVICE_MARKER=openclaw" "OPENCLAW_SERVICE_KIND=node" "OPENCLAW_GATEWAY_TOKEN=synthetic-token"\n',
    );
    await write(path.join(userDir, "clawdbot-gateway.service"), CLAWDBOT_GATEWAY_CONTENTS);
    await write("/lib/systemd/system", "unreadable service directory");

    const extras = await findExtraGatewayServices({ HOME: home }, { deep: true });

    expect(extras.services.map((service) => service.label).toSorted()).toEqual([
      "clawdbot-gateway.service",
      "openclaw@.service",
      "rescue.service",
      "vendor-gateway.service",
    ]);
    expect(extras.errors).toEqual([
      { source: "/lib/systemd/system", message: expect.stringContaining("could not be inspected") },
    ]);
    for (const service of extras.services) {
      expect(service).not.toHaveProperty("extra");
    }
  });

  it("reports global and custom launchd extras without admitting authenticated Node jobs", async () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "darwin" });
    const home = tempDirs.make("managed-launchd-", os.tmpdir());
    const write = isolateNativeRoots(home);
    const userDir = path.join(home, "Library/LaunchAgents");
    const plist = (label: string, executable = "openclaw", command = "gateway") =>
      `<plist><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array><string>/usr/bin/${executable}</string><string>${command}</string></array></dict></plist>`;
    for (const label of ["ai.openclaw.gateway", "ai.openclaw.gateway.dev", "org.example.rescue"]) {
      await write(path.join(userDir, `${label}.plist`), plist(label));
    }
    await write("/Library/LaunchAgents/org.example.global.plist", plist("org.example.global"));
    await write("/Library/LaunchDaemons/ai.openclaw.gateway.plist", plist("ai.openclaw.gateway"));
    await write(
      "/Library/LaunchDaemons/ai.openclaw.node.plist",
      plist("ai.openclaw.node", "openclaw", "node").replace(
        "</dict>",
        "<key>EnvironmentVariables</key><dict><key>OPENCLAW_SERVICE_MARKER</key><string>openclaw</string><key>OPENCLAW_SERVICE_KIND</key><string>node</string><key>OPENCLAW_GATEWAY_TOKEN</key><string>synthetic-token</string></dict></dict>",
      ),
    );
    await write(
      path.join(userDir, "com.clawdbot.gateway.plist"),
      plist("com.clawdbot.gateway", "clawdbot"),
    );
    const unreadable = path.join(userDir, "ai.openclaw.broken.plist");
    await write(unreadable, "malformed plist");

    const extras = await findExtraGatewayServices({ HOME: home }, { deep: true });

    expect(
      extras.services.map((service) => `${service.scope}:${service.label}`).toSorted(),
    ).toEqual([
      "system:ai.openclaw.gateway",
      "system:org.example.global",
      "user:com.clawdbot.gateway",
      "user:org.example.rescue",
    ]);
    expect(extras.errors).toEqual([
      { source: unreadable, message: expect.stringContaining("could not be inspected") },
    ]);
    for (const service of extras.services) {
      expect(service).not.toHaveProperty("extra");
    }
  });
});

describe("findExtraGatewayServices (win32)", () => {
  const originalPlatform = process.platform;
  const task = (taskPath: string, executable: string, args: string) => ({
    taskPath,
    state: null,
    actions: [{ type: 0, path: executable, arguments: args, workingDirectory: "" }],
  });

  beforeEach(() => {
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    listScheduledTasksMock.mockReset().mockReturnValue([]);
    readScheduledTaskCommandMock.mockReset();
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
  });

  it("skips Scheduled Task queries unless deep mode is enabled", async () => {
    await expect(findExtraGatewayServices({})).resolves.toEqual({ services: [], errors: [] });
    expect(listScheduledTasksMock).not.toHaveBeenCalled();
  });

  it("reports query failures as incomplete inspection without inventing a cleanup target", async () => {
    listScheduledTasksMock.mockImplementation(() => {
      throw new Error("Access denied");
    });

    const result = await findExtraGatewayServices({}, { deep: true });

    expect(result).toEqual({
      services: [],
      errors: [{ source: "schtasks", message: expect.stringContaining("could not be queried") }],
    });
    expect(renderGatewayServiceCleanupHints(result.services)).toEqual([]);
  });

  it("keeps verified Node and legacy services while rejecting an unrelated branded monitor", async () => {
    listScheduledTasksMock.mockReturnValue([
      task("\\OpenClaw Gateway", "C:\\OpenClaw\\openclaw.exe", "gateway run"),
      task("\\OpenClaw Gateway (dev)", "C:\\OpenClaw\\openclaw.exe", "gateway run --profile dev"),
      task("\\OpenClaw Gateway Backup", "C:\\OpenClaw\\openclaw.exe", "gateway run"),
      task(
        "\\OpenClaw Node",
        "C:\\Program Files\\nodejs\\node.exe",
        '"C:\\OpenClaw\\dist\\entry.js" node run',
      ),
      task("\\Clawdbot Legacy", "C:\\clawdbot\\clawdbot.exe", "run"),
      task(
        "\\OpenClaw Gateway Monitor",
        "C:\\tools\\monitor.exe",
        "--gateway-url http://127.0.0.1:18789",
      ),
      {
        taskPath: "\\OpenClaw CrossAction",
        state: null,
        actions: [
          {
            type: 0,
            path: "C:\\OpenClaw\\openclaw.exe",
            arguments: "node run",
            workingDirectory: "",
          },
          {
            type: 0,
            path: "C:\\tools\\helper.exe",
            arguments: "gateway run",
            workingDirectory: "",
          },
        ],
      },
    ]);

    const result = await findExtraGatewayServices({}, { deep: true });

    expect(result.errors).toEqual([]);
    expect(result.services).toEqual([
      expect.objectContaining({
        label: "\\OpenClaw Gateway Backup",
        marker: "openclaw",
        legacy: false,
      }),
      expect.objectContaining({ label: "\\OpenClaw Node", marker: "openclaw", legacy: false }),
      expect.objectContaining({ label: "\\Clawdbot Legacy", marker: "clawdbot", legacy: true }),
      expect.objectContaining({
        label: "\\OpenClaw CrossAction",
        marker: "openclaw",
        legacy: false,
      }),
    ]);
    expect(renderGatewayServiceCleanupHints(result.services).join("\n")).not.toContain("Monitor");
    for (const service of result.services) {
      expect(service).not.toHaveProperty("extra");
    }
  });

  it.each(["gateway", "node"])(
    "recognizes verified %s launcher metadata independently of the task label",
    async (kind) => {
      listScheduledTasksMock.mockReturnValue([
        task("\\Custom Service", "C:\\fixtures\\service.cmd", ""),
      ]);
      readScheduledTaskCommandMock.mockResolvedValue({
        programArguments: ["C:\\runtime\\node.exe", "C:\\app\\entry.js", kind, "run"],
        environment: { OPENCLAW_SERVICE_MARKER: "openclaw", OPENCLAW_SERVICE_KIND: kind },
      });

      const result = await findExtraGatewayServices({}, { deep: true });

      expect(result.errors).toEqual([]);
      expect(result.services).toEqual([
        expect.objectContaining({ label: "\\Custom Service", marker: "openclaw", legacy: false }),
      ]);
    },
  );

  it.each([{ actions: undefined }, { actions: [] }])(
    "retains incomplete known selectors with missing actions $actions",
    async ({ actions }) => {
      listScheduledTasksMock.mockReturnValue([
        { taskPath: "\\OpenClaw Gateway", state: null, actions },
        { taskPath: "\\Selected Custom", state: null, actions },
      ]);
      const env = { OPENCLAW_WINDOWS_TASK_NAME: "\\Selected Custom" };

      const extras = await findExtraGatewayServices(env, { deep: true });

      expect(extras.services).toEqual([]);
      expect(extras.errors).toEqual([
        {
          source: "\\OpenClaw Gateway",
          message: expect.stringContaining("could not be inspected"),
        },
        { source: "\\Selected Custom", message: expect.stringContaining("could not be inspected") },
      ]);
    },
  );

  it("does not offer deletion of the selected custom Gateway", async () => {
    listScheduledTasksMock.mockReturnValue([
      task("\\Services\\Selected Gateway", "C:\\OpenClaw\\openclaw.exe", "gateway run"),
    ]);
    const env = { OPENCLAW_WINDOWS_TASK_NAME: "Services\\Selected Gateway" };

    const extras = await findExtraGatewayServices(env, { deep: true });

    expect(extras).toEqual({ services: [], errors: [] });
    expect(renderGatewayServiceCleanupHints(extras.services)).toEqual([]);
  });

  it.each(["\\OpenClaw Gateway (dev)", "\\Clawdbot Gateway"])(
    "reports unreadable known launcher %s before any contents are available",
    async (label) => {
      listScheduledTasksMock.mockReturnValue([task(label, "C:\\custom\\gateway.cmd", "")]);
      readScheduledTaskCommandMock.mockRejectedValue(new Error("Access denied"));

      const result = await findExtraGatewayServices({}, { deep: true });

      expect(result).toEqual({
        services: [],
        errors: [{ source: label, message: "Scheduled Task launcher could not be inspected." }],
      });
      expect(renderGatewayServiceCleanupHints(result.services)).toEqual([]);
    },
  );

  it("reports a recognizable launcher read failure without offering its deletion", async () => {
    listScheduledTasksMock.mockReturnValue([
      task("\\Custom Service", "C:\\fixtures\\service.cmd", ""),
    ]);
    readScheduledTaskCommandMock.mockImplementationOnce(async (_env, options) => {
      options?.onLauncherContent?.(
        "@echo off\r\nnode C:\\openclaw\\dist\\entry.js gateway run\r\n",
      );
      throw new Error("Nested launcher could not be read");
    });

    const result = await findExtraGatewayServices({}, { deep: true });

    expect(result).toEqual({
      services: [],
      errors: [
        { source: "\\Custom Service", message: expect.stringContaining("could not be inspected") },
      ],
    });
    expect(renderGatewayServiceCleanupHints(result.services)).toEqual([]);
  });
});
