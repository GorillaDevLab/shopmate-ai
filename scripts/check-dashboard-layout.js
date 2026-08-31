// Playwright CLI run-code 文件：在已打开的本地 Dashboard 上执行。
// CLI 以函数表达式读取文件，不接受末尾分号。
// prettier-ignore
async (page) => {
  const results = [];
  for (const width of [375, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.getByRole("heading", { name: "今天的经营，一眼看清" }).waitFor();
    for (const name of ["今日销售额", "今日订单", "今日销量", "客单价"]) {
      await page.getByRole("article", { name, exact: true }).waitFor({ state: "visible" });
    }
    await page.getByText("¥12,680.00", { exact: true }).waitFor();
    await page.getByText("↓ 下降 5.2%", { exact: true }).waitFor();
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
    await page.getByText("已售罄", { exact: true }).waitFor();
    await page.getByText("暂无销量，无法估算", { exact: true }).waitFor();
    await page.getByRole("region", { name: "热销商品", exact: true }).getByText("SKU：BAG-BLACK").waitFor();
    results.push({ width, overflow: layout.overflow, visibleBars: layout.bars.length });
  }
  return results;
}
