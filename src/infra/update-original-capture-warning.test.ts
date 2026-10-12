import { describe, expect, it } from "vitest";
import { formatBestEffortOriginalCaptureWarning } from "./update-original-capture-warning.js";

describe("formatBestEffortOriginalCaptureWarning", () => {
  it("replaces the inspection retry instruction when capture continues", () => {
    const warning = formatBestEffortOriginalCaptureWarning(
      "State schema inspection failed (exit): generation changed. Check access to the reported source, free space, and storage performance, then retry the update.",
    );
    expect(warning).toBe(
      "Original state capture is unavailable: State schema inspection failed (exit): generation changed. Check access to the reported source, free space, and storage performance, the update continues without this capture. A completed update does not need to be restarted because of this warning.",
    );
    expect(warning).not.toContain("retry the update");
  });

  it("states that the update continues when the detail has no retry sentence", () => {
    expect(
      formatBestEffortOriginalCaptureWarning(
        "The original update process identity is unavailable.",
      ),
    ).toBe(
      "Original state capture is unavailable: The original update process identity is unavailable. The update continues without this capture. A completed update does not need to be restarted because of this warning.",
    );
  });
});
