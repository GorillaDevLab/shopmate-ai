// Playwright CLI function expression. Requires an authenticated, seeded local dashboard.
// prettier-ignore
async (page) => {
  page.setDefaultTimeout(8000);
  const results = [];
  const errors = [];
  const requests = [];
  const onError = error => errors.push(error.message);
  const onConsole = message => { if (message.type() === 'error') errors.push(message.text()); };
  const onRequest = request => { if (request.url().includes('/api/v1/analytics/dashboard')) requests.push(request.url()); };
  page.on('pageerror', onError);
  page.on('console', onConsole);
  page.on('request', onRequest);
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.reload();
    const trend = page.getByRole('region', { name: '销售趋势', exact: true });
    await trend.waitFor();
    const point = trend.getByRole('button').first();
    await point.click();
    const selected = await point.getAttribute('aria-label');
    const amount = await page.getByRole('article', { name: '近 7 天销售额' }).innerText();
    const before = requests.length;
    for (const [name, value] of [['经典紫色', 'purple'], ['暖灰陶土', 'terracotta']]) {
      await page.getByRole('button', { name: '外观设置', exact: true }).click();
      await page.locator('label').filter({ has: page.getByRole('radio', { name, exact: true }) }).click();
      await page.keyboard.press('Escape');
      await page.getByRole('dialog').waitFor({ state: 'detached' });
      if (!(await page.getByRole('button', { name: '外观设置', exact: true }).evaluate(el => el === document.activeElement))) throw new Error('Focus not restored');
      if (await page.locator('html').getAttribute('data-theme') !== value) throw new Error('Wrong theme');
      if (await page.getByRole('article', { name: '近 7 天销售额' }).innerText() !== amount) throw new Error('Metric changed');
      if (await trend.getByRole('button', { name: selected, exact: true }).getAttribute('aria-pressed') !== 'true') throw new Error('Chart selection reset');
      if (requests.length !== before) throw new Error('Theme change refetched dashboard');
      await page.screenshot({ path: `C:/Users/harry/AppData/Local/ShopMateDev/dashboard-${value}.png`, fullPage: true });
      results.push({ value, requestsUnchanged: true });
    }
    await page.getByRole('button', { name: '外观设置', exact: true }).click();
    await page.locator('label').filter({ has: page.getByRole('radio', { name: '经典紫色', exact: true }) }).click();
    await page.keyboard.press('Escape');
    await page.addInitScript(() => {
      requestAnimationFrame(() => { window.__themeAtFirstFrame = document.documentElement.dataset.theme; });
    });
    await page.reload();
    await trend.waitFor();
    if (await page.locator('html').getAttribute('data-theme') !== 'purple') throw new Error('Preference not restored');
    if (await page.evaluate(() => window.__themeAtFirstFrame) !== 'purple') throw new Error('Theme not restored at first frame');
    await page.setViewportSize({ width: 375, height: 812 });
    await page.getByRole('button', { name: '外观设置', exact: true }).click();
    const dialog = page.getByRole('dialog');
    const bounds = await dialog.boundingBox();
    if (!bounds || bounds.x < 0 || bounds.x + bounds.width > 375) throw new Error('Mobile dialog overflow');
    await page.getByRole('radio', { name: '暖灰陶土', exact: true }).focus();
    await page.keyboard.press('ArrowRight');
    if (!(await page.getByRole('radio', { name: '经典紫色', exact: true }).isChecked())) throw new Error('Radio keyboard navigation failed');
    await page.keyboard.press('Tab');
    // Native dialogs can hand focus to browser chrome; the next Tab must return to the modal.
    if (!(await page.evaluate(() => document.hasFocus()))) await page.keyboard.press('Tab');
    if (!(await dialog.evaluate(el => el.contains(document.activeElement)))) throw new Error('Focus escaped dialog');
    await page.screenshot({ path: 'C:/Users/harry/AppData/Local/ShopMateDev/dashboard-theme-mobile.png' });
    await page.keyboard.press('Escape');
    if (errors.length) throw new Error(errors.join('\n'));
    return { results, restored: true, mobileDialog: bounds, errors };
  } finally {
    page.off('pageerror', onError);
    page.off('console', onConsole);
    page.off('request', onRequest);
  }
}
