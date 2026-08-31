// Playwright CLI run-code 文件：在已打开的本地 Dashboard 上执行。
// CLI 以函数表达式读取文件，不接受末尾分号。
// prettier-ignore
async (page) => {
  const results = [];
  for (const width of [375, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.getByRole("heading", { name: "今天的经营，一眼看清" }).waitFor();
    const layout = await page.locator("main").evaluate((main) => {
      const viewport = main.ownerDocument.documentElement.clientWidth;
      const overflow = [...main.querySelectorAll("*")].filter((element) => {
        const box = element.getBoundingClientRect();
        return box.width > 0 && (box.left < -1 || box.right > viewport + 1);
      }).length;
      const bars = [...main.querySelectorAll('[role="img"] [style]')].map(
        (element) => element.getBoundingClientRect().height,
      );
      return { viewport, overflow, bars };
    });
    if (layout.viewport !== width || layout.overflow > 0) {
      throw new Error(`${width}px 布局溢出：${JSON.stringify(layout)}`);
    }
    if (layout.bars.length !== 7 || layout.bars.some((height) => height <= 0)) {
      throw new Error(`${width}px 趋势柱不可见：${JSON.stringify(layout.bars)}`);
    }
    if (!(await page.getByRole("button", { name: "查看全部提醒（演示）" }).isDisabled())) {
      throw new Error("未实现的演示操作应明确禁用");
    }
    results.push({ width, overflow: layout.overflow, visibleBars: layout.bars.length });
  }
  return results;
}
