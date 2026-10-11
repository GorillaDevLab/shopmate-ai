import { describe, expect, it, vi } from "vitest";
import type { MockSourceWorker } from "@shopmate/database/mock-platform";
import { runSourcePass } from "./runner.js";

describe("background source discovery", () => {
  it("does not discover work after shutdown", async () => {
    const listBuildScopes = vi.fn();
    const controller = new AbortController();
    controller.abort();
    const worker = { listBuildScopes } as unknown as MockSourceWorker;
    expect(await runSourcePass(worker, controller.signal)).toEqual([]);
    expect(listBuildScopes).not.toHaveBeenCalled();
  });
  it("handles no granted scopes as an empty pass", async () => {
    const worker = { listBuildScopes: vi.fn(async () => []) } as unknown as MockSourceWorker;
    expect(await runSourcePass(worker)).toEqual([]);
  });
});
