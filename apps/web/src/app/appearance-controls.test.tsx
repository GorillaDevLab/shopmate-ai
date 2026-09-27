import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AppearanceProvider, useAppearance } from "./appearance-provider";
import { AppearanceControls } from "./appearance-controls";
import { readAppearance, DEFAULT_APPEARANCE, APPEARANCE_STORAGE_KEY } from "./appearance-model";

function Cards() {
  const appearance = useAppearance();
  const { setCards } = appearance;
  useEffect(() => {
    setCards([{ id: "sales", title: "销售额" }]);
  }, [setCards]);
  return (
    <output aria-label="当前主色">
      {appearance.settings.cards.sales?.primary ?? appearance.settings.widgets.primary}
    </output>
  );
}
function setup() {
  render(
    <AppearanceProvider>
      <AppearanceControls />
      <Cards />
    </AppearanceProvider>,
  );
}
async function openStudio() {
  await waitFor(() => expect(screen.getByRole("button", { name: "灵动" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "灵动" }));
  fireEvent.click(screen.getByRole("button", { name: "装饰工作台" }));
  return screen.findByRole("dialog", { name: "让工作台，有你的风格" });
}
beforeEach(() => {
  localStorage.clear();
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
});
afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

it("默认冷静，切换灵动并保存选择", async () => {
  setup();
  expect(screen.getByRole("button", { name: "冷静" })).toHaveAttribute("aria-pressed", "true");
  await openStudio();
  expect(readAppearance().settings.mode).toBe("vivid");
});

it("取消装饰不覆盖已保存值", async () => {
  setup();
  await openStudio();
  fireEvent.change(screen.getByLabelText("主色"), { target: { value: "#ff5500" } });
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  expect(readAppearance().settings.page.primary).toBe(DEFAULT_APPEARANCE.page.primary);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it("单卡保存并在两种模式间保留", async () => {
  setup();
  await openStudio();
  fireEvent.change(screen.getByLabelText("装饰对象"), { target: { value: "card:sales" } });
  fireEvent.change(screen.getByLabelText("主色"), { target: { value: "#ff5500" } });
  fireEvent.click(screen.getByRole("button", { name: "保存装饰" }));
  expect(readAppearance().settings.cards.sales.primary).toBe("#ff5500");
  fireEvent.click(screen.getByRole("button", { name: "冷静" }));
  expect(readAppearance().settings.cards.sales.primary).toBe("#ff5500");
  fireEvent.click(screen.getByRole("button", { name: "灵动" }));
  expect(screen.getByLabelText("当前主色")).toHaveTextContent("#ff5500");
});

it("恢复全部需要确认，取消确认不会丢设置", async () => {
  localStorage.setItem(
    APPEARANCE_STORAGE_KEY,
    JSON.stringify({
      ...DEFAULT_APPEARANCE,
      mode: "vivid",
      page: { ...DEFAULT_APPEARANCE.page, primary: "#ff5500" },
    }),
  );
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  setup();
  await openStudio();
  fireEvent.click(screen.getByRole("button", { name: "恢复全部默认" }));
  expect(confirm).toHaveBeenCalledOnce();
  expect(screen.getByLabelText("主色")).toHaveValue("#ff5500");
});

it("存储拒绝时显示错误，不假装保存成功", async () => {
  setup();
  await openStudio();
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("denied");
  });
  fireEvent.click(screen.getByRole("button", { name: "保存装饰" }));
  expect(screen.getByRole("dialog")).toBeInTheDocument();
  expect(screen.getAllByText(/当前浏览器无法保存装饰/).length).toBeGreaterThan(0);
});

it("单卡可恢复继承，全局应用需确认后才清除覆盖", async () => {
  localStorage.setItem(
    APPEARANCE_STORAGE_KEY,
    JSON.stringify({
      ...DEFAULT_APPEARANCE,
      cards: { sales: { ...DEFAULT_APPEARANCE.widgets, primary: "#ff5500" } },
    }),
  );
  setup();
  await openStudio();
  fireEvent.change(screen.getByLabelText("装饰对象"), { target: { value: "card:sales" } });
  fireEvent.click(screen.getByRole("button", { name: "恢复继承全局材质" }));
  expect(screen.getByLabelText("主色")).toHaveValue(DEFAULT_APPEARANCE.widgets.primary);
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  expect(readAppearance().settings.cards.sales.primary).toBe("#ff5500");
  await openStudio();
  fireEvent.change(screen.getByLabelText("装饰对象"), { target: { value: "widgets" } });
  vi.spyOn(window, "confirm").mockReturnValue(true);
  fireEvent.click(screen.getByRole("button", { name: "日落粉橙" }));
  fireEvent.click(screen.getByRole("button", { name: "应用到所有组件" }));
  fireEvent.click(screen.getByRole("button", { name: "保存装饰" }));
  expect(readAppearance().settings.cards).toEqual({});
  expect(readAppearance().settings.widgets.primary).toBe("#ff5cbb");
});

it("恢复默认取消不落盘，确认保存才生效", async () => {
  setup();
  await openStudio();
  fireEvent.click(screen.getByRole("button", { name: "日落粉橙" }));
  fireEvent.click(screen.getByRole("button", { name: "保存装饰" }));
  await openStudio();
  vi.spyOn(window, "confirm").mockReturnValue(true);
  fireEvent.click(screen.getByRole("button", { name: "恢复全部默认" }));
  expect(readAppearance().settings.page.primary).toBe("#ff5cbb");
  fireEvent.click(screen.getByRole("button", { name: "保存装饰" }));
  expect(readAppearance().settings.page).toEqual(DEFAULT_APPEARANCE.page);
});
