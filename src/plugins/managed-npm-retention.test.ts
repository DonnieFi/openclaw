import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  resolvePluginNpmGenerationProjectDir,
  resolvePluginNpmProjectDir,
} from "./install-paths.js";
import { RETAINED_MANAGED_NPM_KEEP_FILES_REASON } from "./managed-npm-retention-contract.js";
import {
  cleanupRetainedManagedNpmInstallGenerations,
  hasRetainedManagedNpmInstallMarker,
  markRetainedManagedNpmInstall,
} from "./managed-npm-retention.js";

const retentionTempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("managed npm retention", () => {
  it.each(["ordinary", "generation"] as const)(
    "cleans a retired %s project while preserving the active install root",
    async (layout) => {
      const stateDir = retentionTempDirs.make("openclaw-retention-");
      const npmDir = path.join(stateDir, "npm");
      const packageName = "@openclaw/codex";
      const oldProjectRoot =
        layout === "ordinary"
          ? resolvePluginNpmProjectDir({ npmDir, packageName })
          : resolvePluginNpmGenerationProjectDir({
              npmDir,
              packageName,
              generationKey: "codex-v1",
            });
      const activeProjectRoot = resolvePluginNpmGenerationProjectDir({
        npmDir,
        packageName,
        generationKey: "codex-v2",
      });
      const oldPackageDir = path.join(oldProjectRoot, "node_modules", "@openclaw", "codex");
      const activePackageDir = path.join(activeProjectRoot, "node_modules", "@openclaw", "codex");
      fs.mkdirSync(oldPackageDir, { recursive: true });
      fs.mkdirSync(activePackageDir, { recursive: true });
      await markRetainedManagedNpmInstall({
        packageDir: oldPackageDir,
        pluginId: "codex",
        reason: "test-retired-generation",
      });

      await expect(
        cleanupRetainedManagedNpmInstallGenerations({
          npmDir,
          activeInstallPaths: [activePackageDir],
        }),
      ).resolves.toBe(1);
      expect(fs.existsSync(oldProjectRoot)).toBe(false);
      expect(fs.existsSync(activeProjectRoot)).toBe(true);
      expect(hasRetainedManagedNpmInstallMarker(activePackageDir)).toBe(false);
    },
  );

  it("cleans retained packages from the legacy shared npm root", async () => {
    const stateDir = retentionTempDirs.make("openclaw-retention-");
    const npmDir = path.join(stateDir, "npm");
    const packageDir = path.join(npmDir, "node_modules", "@openclaw", "codex");
    fs.mkdirSync(packageDir, { recursive: true });
    await markRetainedManagedNpmInstall({
      packageDir,
      pluginId: "codex",
      reason: "test-legacy-generation",
    });

    await expect(
      cleanupRetainedManagedNpmInstallGenerations({
        npmDir,
      }),
    ).resolves.toBe(1);
    expect(fs.existsSync(packageDir)).toBe(false);
    expect(hasRetainedManagedNpmInstallMarker(packageDir)).toBe(false);
  });

  it("preserves a noncanonical project root even when it has a retained marker", async () => {
    const stateDir = retentionTempDirs.make("openclaw-retention-noncanonical-");
    const npmDir = path.join(stateDir, "npm");
    const projectRoot = path.join(npmDir, "projects", "noncanonical-sibling");
    const packageDir = path.join(projectRoot, "node_modules", "@openclaw", "codex");
    const siblingFile = path.join(projectRoot, "must-remain.txt");
    fs.mkdirSync(packageDir, { recursive: true });
    fs.writeFileSync(siblingFile, "preserve me", "utf8");
    await markRetainedManagedNpmInstall({
      packageDir,
      pluginId: "codex",
      reason: "test-retired-generation",
    });

    await expect(cleanupRetainedManagedNpmInstallGenerations({ npmDir })).resolves.toBe(0);
    expect(fs.readFileSync(siblingFile, "utf8")).toBe("preserve me");
  });

  it("does not follow a substituted managed projects directory", async () => {
    const stateDir = retentionTempDirs.make("openclaw-retention-symlink-");
    const npmDir = path.join(stateDir, "npm");
    const outsideProjectsDir = retentionTempDirs.make("openclaw-retention-outside-");
    fs.mkdirSync(npmDir, { recursive: true });
    fs.symlinkSync(outsideProjectsDir, path.join(npmDir, "projects"), "dir");
    const projectRoot = resolvePluginNpmProjectDir({
      npmDir,
      packageName: "@openclaw/codex",
    });
    const packageDir = path.join(projectRoot, "node_modules", "@openclaw", "codex");
    const sentinel = path.join(projectRoot, "must-remain.txt");
    fs.mkdirSync(packageDir, { recursive: true });
    fs.writeFileSync(sentinel, "preserve me", "utf8");
    await markRetainedManagedNpmInstall({
      packageDir,
      pluginId: "codex",
      reason: "test-retired-generation",
    });

    await expect(cleanupRetainedManagedNpmInstallGenerations({ npmDir })).resolves.toBe(0);
    expect(fs.readFileSync(sentinel, "utf8")).toBe("preserve me");
  });

  it.each(["project", "legacy"] as const)(
    "preserves %s packages retained by an explicit keep-files uninstall",
    async (layout) => {
      const stateDir = retentionTempDirs.make("openclaw-retention-");
      const npmDir = path.join(stateDir, "npm");
      const projectRoot =
        layout === "legacy"
          ? npmDir
          : resolvePluginNpmGenerationProjectDir({
              npmDir,
              packageName: "@openclaw/kept-plugin",
              generationKey: "kept-plugin-v1",
            });
      const packageDir = path.join(projectRoot, "node_modules", "@openclaw", "kept-plugin");
      fs.mkdirSync(packageDir, { recursive: true });
      await markRetainedManagedNpmInstall({
        packageDir,
        pluginId: "kept-plugin",
        reason: RETAINED_MANAGED_NPM_KEEP_FILES_REASON,
      });

      await expect(cleanupRetainedManagedNpmInstallGenerations({ npmDir })).resolves.toBe(0);
      expect(fs.existsSync(packageDir)).toBe(true);
      expect(hasRetainedManagedNpmInstallMarker(packageDir)).toBe(true);
    },
  );

  it.each(["stat", "mkdir"] as const)(
    "does not publish a retention marker when authority is revoked after %s",
    async (phase) => {
      const stateDir = retentionTempDirs.make("openclaw-retention-revoke-");
      const npmDir = path.join(stateDir, "npm");
      const packageDir = path.join(npmDir, "node_modules", "@openclaw", "codex");
      fs.mkdirSync(packageDir, { recursive: true });
      const expired = new Error("approved operation owner expired");
      let ownerActive = true;
      const beforePersistentEffect = () => {
        if (!ownerActive) {
          throw expired;
        }
      };
      const revokeAfterAwait = () => {
        ownerActive = false;
      };
      const stat = fs.promises.stat.bind(fs.promises);
      const mkdir = fs.promises.mkdir.bind(fs.promises);
      const spy =
        phase === "stat"
          ? vi.spyOn(fs.promises, "stat").mockImplementation(async (...args) => {
              try {
                return await stat(...args);
              } finally {
                revokeAfterAwait();
              }
            })
          : vi.spyOn(fs.promises, "mkdir").mockImplementation(async (...args) => {
              try {
                return await mkdir(...args);
              } finally {
                revokeAfterAwait();
              }
            });

      try {
        await expect(
          markRetainedManagedNpmInstall({
            packageDir,
            pluginId: "codex",
            reason: RETAINED_MANAGED_NPM_KEEP_FILES_REASON,
            beforePersistentEffect,
          }),
        ).rejects.toBe(expired);
        expect(hasRetainedManagedNpmInstallMarker(packageDir)).toBe(false);
      } finally {
        spy.mockRestore();
      }
    },
  );

  it("does not publish further retention markers after authority is revoked mid-loop", async () => {
    const stateDir = retentionTempDirs.make("openclaw-retention-revoke-loop-");
    const npmDir = path.join(stateDir, "npm");
    const firstPackageDir = path.join(npmDir, "node_modules", "@openclaw", "codex");
    const secondPackageDir = path.join(npmDir, "node_modules", "@openclaw", "codex-older");
    fs.mkdirSync(firstPackageDir, { recursive: true });
    fs.mkdirSync(secondPackageDir, { recursive: true });
    const expired = new Error("approved operation owner expired");
    let ownerActive = true;
    const beforePersistentEffect = () => {
      if (!ownerActive) {
        throw expired;
      }
    };
    const writeFile = fs.promises.writeFile.bind(fs.promises);
    const spy = vi
      .spyOn(fs.promises, "writeFile")
      .mockImplementation(async (file, data, options) => {
        const result = await writeFile(file, data, options);
        if (String(file).includes(".openclaw-retained-npm-installs")) {
          ownerActive = false;
        }
        return result;
      });

    try {
      await expect(
        markRetainedManagedNpmInstall({
          packageDir: firstPackageDir,
          pluginId: "codex",
          reason: RETAINED_MANAGED_NPM_KEEP_FILES_REASON,
          beforePersistentEffect,
        }),
      ).resolves.toBe(true);
      await expect(
        markRetainedManagedNpmInstall({
          packageDir: secondPackageDir,
          pluginId: "codex",
          reason: RETAINED_MANAGED_NPM_KEEP_FILES_REASON,
          beforePersistentEffect,
        }),
      ).rejects.toBe(expired);
      expect(hasRetainedManagedNpmInstallMarker(firstPackageDir)).toBe(true);
      expect(hasRetainedManagedNpmInstallMarker(secondPackageDir)).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});
