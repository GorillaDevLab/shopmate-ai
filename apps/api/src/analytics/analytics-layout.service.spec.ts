import {
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { DEFAULT_ANALYTICS_LAYOUT } from "@shopmate/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createAuthContext } from "../auth/contracts/index.js";
import type { AnalyticsLayoutRepository } from "./analytics-layout.repository.js";
import { AnalyticsLayoutService } from "./analytics-layout.service.js";

describe("AnalyticsLayoutService", () => {
  const context = createAuthContext({ userId: "u1", merchantId: "m1", permissions: [] });
  const repository = { find: vi.fn(), save: vi.fn() } satisfies AnalyticsLayoutRepository;
  const service = new AnalyticsLayoutService(repository);
  const updatedAt = new Date("2026-09-28T00:00:00.000Z");
  const custom = { version: 1 as const, cards: [{ id: "sales" as const, span: 3 as const }] };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the default layout at revision 0 when nothing is saved", async () => {
    repository.find.mockResolvedValue(null);
    await expect(service.get(context)).resolves.toEqual({
      layout: DEFAULT_ANALYTICS_LAYOUT,
      revision: 0,
      updatedAt: null,
    });
  });

  it("falls back to the default layout for unreadable records but keeps the revision", async () => {
    repository.find.mockResolvedValue({ layout: { version: 9 }, revision: 4, updatedAt });
    await expect(service.get(context)).resolves.toEqual({
      layout: DEFAULT_ANALYTICS_LAYOUT,
      revision: 4,
      updatedAt: updatedAt.toISOString(),
    });
  });

  it("saves a validated layout with the expected revision", async () => {
    repository.save.mockResolvedValue({
      kind: "saved",
      record: { layout: custom, revision: 2, updatedAt },
    });
    await expect(service.save(context, { layout: custom, expectedRevision: 1 })).resolves.toEqual({
      layout: custom,
      revision: 2,
      updatedAt: updatedAt.toISOString(),
    });
    expect(repository.save).toHaveBeenCalledWith(context, custom, 1);
  });

  it("rejects invalid bodies without touching storage", async () => {
    await expect(
      service.save(context, {
        layout: { version: 1, cards: [{ id: "x", span: 1 }] },
        expectedRevision: 0,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(repository.save).not.toHaveBeenCalled();
  });

  it("reports concurrent edits as a conflict", async () => {
    repository.save.mockResolvedValue({ kind: "conflict" });
    await expect(
      service.save(context, { layout: custom, expectedRevision: 1 }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("maps storage failures to 503", async () => {
    repository.find.mockRejectedValue(new Error("db down"));
    await expect(service.get(context)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
