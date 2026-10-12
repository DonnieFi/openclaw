import { describe, expect, it } from "vitest";
import { applyUpdateDoctorLintReport } from "./update-doctor-lint.js";
import { isFailedUpdateStep } from "./update-run-step.js";
import type { UpdateStepResult } from "./update-step-result.js";

function deferredReport(checksRun: number) {
  return JSON.stringify({
    ok: true,
    checksRun,
    findings: [],
    warnings: [
      {
        checkId: "core/doctor/lint-inspection",
        severity: "warning",
        errorCode: "update-inspection-deferred",
        requirement: "update-validation-budget",
        message:
          "Doctor lint inspection deferred until after activation: 2 agent scopes need a 4000ms inspection allowance, with 0ms remaining in the validation inspection window (validation-ledger).",
        fixHint:
          "Run `openclaw doctor --fix` after activation to complete deferred checks and repairs.",
      },
    ],
  });
}

function step(): UpdateStepResult {
  return {
    name: "candidate-doctor-lint",
    command: "doctor --lint --json --severity-min error",
    cwd: "/tmp/openclaw-fixture",
    durationMs: 1,
    exitCode: 0,
  };
}

describe("applyUpdateDoctorLintReport budget deferral", () => {
  it("marks a skipped advisory inspection without failing the update step", () => {
    const lintStep = step();
    applyUpdateDoctorLintReport(lintStep, deferredReport(0), 0, {});
    expect(lintStep.advisory).toEqual({
      kind: "recoverable-maintenance",
      message: expect.stringContaining("Doctor lint inspection did not run"),
    });
    expect(lintStep.exitCode).toBe(0);
    expect(isFailedUpdateStep(lintStep)).toBe(false);
    expect(lintStep.warnings?.join("\n")).toContain("update-validation-budget");
  });

  it("leaves a partial inspection as a passed step when some checks ran", () => {
    const lintStep = step();
    applyUpdateDoctorLintReport(lintStep, deferredReport(1), 0, {});
    expect(lintStep.advisory).toBeUndefined();
    expect(isFailedUpdateStep(lintStep)).toBe(false);
  });
});
