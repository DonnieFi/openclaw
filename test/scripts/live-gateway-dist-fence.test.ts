import { describe, expect, it } from "vitest";
import {
  isLiveManagedGatewayHoldingDist,
  resolveLiveManagedGatewayDistFence,
} from "../../scripts/lib/live-gateway-dist-fence.mts";
import type { GatewayServiceState } from "../../src/daemon/service-types.ts";

function baseState(overrides: Partial<GatewayServiceState> = {}): GatewayServiceState {
  return {
    installed: true,
    loadState: { status: "loaded" },
    running: false,
    env: {},
    command: {
      programArguments: [
        "/usr/bin/node",
        "/srv/openclaw/dist/index.js",
        "gateway",
        "--port",
        "18789",
      ],
    },
    ...overrides,
  };
}

describe("live-gateway-dist-fence", () => {
  it("allows builds when OPENCLAW_ALLOW_LIVE_DIST_BUILD=1 even if the gateway is live", async () => {
    const result = await resolveLiveManagedGatewayDistFence("/srv/openclaw", {
      env: { OPENCLAW_ALLOW_LIVE_DIST_BUILD: "1" },
      readState: async () => baseState({ running: true }),
      matchesRoot: async () => true,
    });
    expect(result).toEqual({ refuse: false });
  });

  it("allows builds when the managed Gateway does not use this checkout", async () => {
    const result = await resolveLiveManagedGatewayDistFence("/srv/openclaw", {
      readState: async () => baseState({ running: true }),
      matchesRoot: async () => false,
    });
    expect(result).toEqual({ refuse: false });
  });

  it("allows builds when this checkout matches but the Gateway is stopped", async () => {
    const result = await resolveLiveManagedGatewayDistFence("/srv/openclaw", {
      readState: async () =>
        baseState({
          running: false,
          runtime: { status: "stopped", pid: undefined },
        }),
      matchesRoot: async () => true,
      isPidAlive: () => false,
    });
    expect(result).toEqual({ refuse: false });
  });

  it("refuses when this checkout matches and the Gateway is running", async () => {
    const result = await resolveLiveManagedGatewayDistFence("/srv/openclaw", {
      readState: async () =>
        baseState({
          running: true,
          runtime: {
            status: "running",
            pid: 4242,
            systemd: { unit: "openclaw-gateway.service" },
          },
        }),
      matchesRoot: async () => true,
    });
    expect(result.refuse).toBe(true);
    if (result.refuse) {
      expect(result.message).toContain("Refusing to rebuild dist");
      expect(result.message).toContain("/srv/openclaw/dist/index.js");
      expect(result.message).toContain("openclaw-gateway.service");
      expect(result.message).toContain("OPENCLAW_ALLOW_LIVE_DIST_BUILD=1");
    }
  });

  it("refuses while a matching Gateway PID is still alive during deactivating drain", async () => {
    expect(
      isLiveManagedGatewayHoldingDist(
        baseState({
          running: false,
          runtime: { status: "deactivating", subState: "stop-sigterm", pid: 99 },
        }),
        { isPidAlive: (pid) => pid === 99 },
      ),
    ).toBe(true);

    const result = await resolveLiveManagedGatewayDistFence("/srv/openclaw", {
      readState: async () =>
        baseState({
          running: false,
          runtime: { status: "deactivating", subState: "stop-sigterm", pid: 99 },
        }),
      matchesRoot: async () => true,
      isPidAlive: (pid) => pid === 99,
    });
    expect(result.refuse).toBe(true);
  });

  it("fails open when service inspection throws", async () => {
    const result = await resolveLiveManagedGatewayDistFence("/srv/openclaw", {
      readState: async () => {
        throw new Error("no systemd");
      },
    });
    expect(result).toEqual({ refuse: false });
  });
});
