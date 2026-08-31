// Run with Playwright CLI on a local Dashboard with an authenticated Demo session and seeded data.
// CLI reads this file as a function expression, without a trailing semicolon.
// prettier-ignore
async (page) => {
  page.setDefaultTimeout(10000);
  const results = [];
  const checkBounds = async (width) => {
    const bounds = await page.locator("main").evaluate(main => {
      const root = main.ownerDocument.documentElement;
      const overflow = [...main.querySelectorAll("*")].filter(element => {
        const box = element.getBoundingClientRect();
        return box.width > 0 && (box.left < -1 || box.right > root.clientWidth + 1);
      }).length;
      return { width: root.clientWidth, height: root.scrollHeight, overflow };
    });
    if (bounds.width !== width || bounds.overflow > 0) throw new Error("Dashboard overflow: " + JSON.stringify(bounds));
    if (width === 1440 && bounds.height > 900) throw new Error("Seeded desktop dashboard exceeds one screen");
    return bounds;
  };
  for (const width of [375, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.reload();
    await page.getByRole("region", { name: "销售趋势", exact: true }).waitFor();
    for (const days of [30, 7]) {
      const responsePromise = page.waitForResponse(response => response.url().includes("/api/v1/analytics/dashboard?"));
      await page.getByRole("button", { name: `近 ${days} 天`, exact: true }).click();
      const response = await responsePromise;
      if (!response.ok()) throw new Error("Dashboard API returned " + response.status());
      const data = await response.json();
      if (data.period.days !== days || data.trend.length !== days) throw new Error("Wrong API period");
      await page.getByRole("region", { name: "销售趋势", exact: true }).waitFor();
      const card = page.getByRole("article", { name: `近 ${days} 天销售额`, exact: true });
      const money = "¥" + (data.metrics.find(metric => metric.key === "sales").value / 100).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      if (!(await card.innerText()).includes(money)) throw new Error("Metric does not match API");
      results.push({ days, ...await checkBounds(width) });
    }
    await page.getByRole("button", { name: "自选时段", exact: true }).click();
    await page.getByRole("dialog").waitFor();
    await page.getByLabel("开始日期").fill("2026-08-10");
    await page.getByLabel("结束日期").fill("2026-08-15");
    await page.getByRole("button", { name: "应用时段" }).click();
    await page.getByRole("region", { name: "销售趋势", exact: true }).waitFor();
    results.push({ custom: true, ...await checkBounds(width) });
  }
  return results;
}
