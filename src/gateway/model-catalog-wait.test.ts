import { afterEach, expect, it, vi } from "vitest";
import { createModelCatalogWait } from "./model-catalog-wait.js";

afterEach(() => {
  vi.useRealTimers();
});

it("ends staggered overlapping catalog waits when the request's one budget runs out", async () => {
  vi.useFakeTimers();
  const waitForModelCatalog = createModelCatalogWait({ assertCurrent: () => {} });
  const unpublished = new Promise<never>(() => {});
  const settled: string[] = [];
  const track = (name: string, wait: Promise<unknown>) =>
    wait.catch((error: unknown) => {
      settled.push(`${name}:${error instanceof Error ? error.message : String(error)}`);
    });

  void track("first agent", waitForModelCatalog(unpublished));
  await vi.advanceTimersByTimeAsync(20_000);
  void track("second agent", waitForModelCatalog(unpublished));
  await vi.advanceTimersByTimeAsync(10_000);

  expect(settled).toEqual([
    "first agent:Models are still loading; retry in a moment.",
    "second agent:Models are still loading; retry in a moment.",
  ]);
});
