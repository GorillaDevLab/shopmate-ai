import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { render } from "../../test/assistant-render";

const api = vi.hoisted(() => ({
  listMemories: vi.fn(),
  deleteMemory: vi.fn(),
  clearMemories: vi.fn(),
}));
vi.mock("./memory-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./memory-api")>()),
  ...api,
}));

import { MemoryPanel } from "./memory-panel";

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
});

const memory = { id: "m1", content: "常看北京朝阳店", createdAt: "2026-09-28T00:00:00.000Z" };

describe("MemoryPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.listMemories.mockResolvedValue([memory]);
    api.deleteMemory.mockResolvedValue(undefined);
  });

  it("loads memories only when opened", async () => {
    render(<MemoryPanel />);
    expect(api.listMemories).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "记忆" }));
    expect(await screen.findByText("常看北京朝阳店")).toBeInTheDocument();
  });

  it("asks for confirmation before deleting a memory", async () => {
    render(<MemoryPanel />);
    fireEvent.click(screen.getByRole("button", { name: "记忆" }));
    fireEvent.click(await screen.findByRole("button", { name: "删除记忆：常看北京朝阳店" }));
    expect(api.deleteMemory).not.toHaveBeenCalled();
    const confirm = screen.getByRole("alertdialog", { name: "删除这条记忆？" });
    fireEvent.click(within(confirm).getByRole("button", { name: "取消" }));
    expect(api.deleteMemory).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "删除记忆：常看北京朝阳店" }));
    api.listMemories.mockResolvedValue([]);
    fireEvent.click(
      within(screen.getByRole("alertdialog", { name: "删除这条记忆？" })).getByRole("button", {
        name: "删除",
      }),
    );
    await waitFor(() => expect(api.deleteMemory).toHaveBeenCalledWith("m1"));
    expect(await screen.findByText("还没有记住任何偏好。")).toBeInTheDocument();
  });

  it("deletes all conversation history only after explicit confirmation", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<MemoryPanel />);
    fireEvent.click(screen.getByRole("button", { name: "记忆" }));
    fireEvent.click(await screen.findByRole("button", { name: "删除全部对话记录" }));
    const confirm = screen.getByRole("alertdialog", { name: "删除全部对话记录？" });
    expect(confirm).toHaveTextContent("无法恢复");
    fireEvent.click(within(confirm).getByRole("button", { name: "删除全部对话" }));
    expect(await screen.findByText("已删除全部对话记录。")).toBeInTheDocument();
    vi.unstubAllGlobals();
  });
});
