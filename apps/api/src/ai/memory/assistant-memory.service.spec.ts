import {
  BadRequestException,
  ConflictException,
  HttpException,
  NotFoundException,
} from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createAuthContext } from "../../auth/contracts/index.js";
import { AssistantMemoryService, AssistantWorkspaceService } from "./assistant-memory.service.js";
import { createRememberPreferenceTool } from "./remember-preference.tool.js";

const context = createAuthContext({ userId: "u1", merchantId: "m1", permissions: [] });
const createdAt = new Date("2026-09-28T00:00:00.000Z");
const snapshot = { version: 1 as const, sessions: [], currentId: "" };

describe("AssistantMemoryService", () => {
  const repository = {
    list: vi.fn(),
    count: vi.fn(),
    create: vi.fn(),
    delete: vi.fn(),
    clear: vi.fn(),
  };
  const service = new AssistantMemoryService(repository);

  beforeEach(() => {
    vi.clearAllMocks();
    repository.count.mockResolvedValue(0);
  });

  it("saves a single-line preference and reports duplicates", async () => {
    repository.create.mockResolvedValueOnce({ id: "a", content: "常看北京朝阳店", createdAt });
    await expect(service.remember(context, "  常看\n北京朝阳店 ")).resolves.toEqual({
      kind: "saved",
      content: "常看 北京朝阳店",
    });
    expect(repository.create).toHaveBeenCalledWith(context, "常看 北京朝阳店");
    repository.create.mockResolvedValueOnce(null);
    await expect(service.remember(context, "常看北京朝阳店")).resolves.toMatchObject({
      kind: "exists",
    });
  });

  it("refuses to grow past the limit and rejects invalid content", async () => {
    repository.count.mockResolvedValue(30);
    await expect(service.remember(context, "回答简短")).resolves.toEqual({ kind: "full" });
    await expect(service.remember(context, "x".repeat(201))).resolves.toEqual({ kind: "invalid" });
    expect(repository.create).not.toHaveBeenCalled();
  });

  it("keeps chatting without preferences when they cannot be read", async () => {
    repository.list.mockRejectedValue(new Error("db down"));
    await expect(service.promptContext(context)).resolves.toEqual([]);
  });

  it("only deletes the caller's own memories", async () => {
    repository.delete.mockResolvedValue(false);
    await expect(service.delete(context, "someone-else")).rejects.toBeInstanceOf(NotFoundException);
    expect(repository.delete).toHaveBeenCalledWith(context, "someone-else");
  });

  it("exposes saving through the remember_preference tool", async () => {
    repository.create.mockResolvedValue({ id: "a", content: "回答简短", createdAt });
    const tool = createRememberPreferenceTool(service);
    await expect(tool.handler({ content: "回答简短" }, context)).resolves.toEqual({
      status: "ok",
      data: { content: "回答简短", alreadyKnown: false },
    });
    repository.count.mockResolvedValue(30);
    await expect(tool.handler({ content: "再记一条" }, context)).resolves.toMatchObject({
      status: "error",
      error: { code: "MEMORY_FULL" },
    });
  });
});

describe("AssistantWorkspaceService", () => {
  const repository = { find: vi.fn(), save: vi.fn(), delete: vi.fn() };
  const service = new AssistantWorkspaceService(repository);

  beforeEach(() => vi.clearAllMocks());

  it("returns an empty workspace at revision 0 and ignores unreadable stored snapshots", async () => {
    repository.find.mockResolvedValueOnce(null);
    await expect(service.get(context)).resolves.toEqual({ snapshot: null, revision: 0 });
    repository.find.mockResolvedValueOnce({ snapshot: { version: 9 }, revision: 5 });
    await expect(service.get(context)).resolves.toEqual({ snapshot: null, revision: 5 });
  });

  it("saves against the expected revision and reports conflicts", async () => {
    repository.save.mockResolvedValueOnce({ kind: "saved", revision: 3 });
    await expect(service.save(context, { snapshot, expectedRevision: 2 })).resolves.toEqual({
      revision: 3,
    });
    expect(repository.save).toHaveBeenCalledWith(context, snapshot, 2);
    repository.save.mockResolvedValueOnce({ kind: "conflict" });
    await expect(service.save(context, { snapshot, expectedRevision: 2 })).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it("rejects invalid bodies and oversized histories before storing", async () => {
    await expect(
      service.save(context, { snapshot: {}, expectedRevision: 0 }),
    ).rejects.toBeInstanceOf(BadRequestException);
    const huge = "长".repeat(8000);
    const session = (id: number) => ({
      id: `s${id}`,
      title: "t",
      draft: "",
      updatedAt: createdAt.toISOString(),
      messages: Array.from({ length: 100 }, (_, i) => ({
        id: `${id}-${i}`,
        role: "assistant" as const,
        content: huge,
        createdAt: createdAt.toISOString(),
        status: "complete" as const,
      })),
    });
    const tooLarge = {
      version: 1,
      sessions: [session(1), session(2), session(3)],
      currentId: "s1",
    };
    const error = await service
      .save(context, { snapshot: tooLarge, expectedRevision: 0 })
      .catch((e) => e);
    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(413);
    expect(repository.save).not.toHaveBeenCalled();
  });
});
