import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

function luminance(hex: string) {
  const channels = hex.match(/[\da-f]{2}/gi)!.map((value) => {
    const channel = parseInt(value, 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

it.each(["terracotta", "purple"])("%s 常规文字对比度至少 4.5:1", (theme) => {
  const css = readFileSync("src/app/globals.css", "utf8");
  const block = (selector: string) => css.slice(css.indexOf(selector)).split("}")[0];
  const tokens = (text: string) =>
    Object.fromEntries(
      [...text.matchAll(/--([\w-]+):\s*(#[\da-f]{6});/gi)].map((match) => [match[1], match[2]]),
    );
  const colors = {
    ...tokens(block(":root {")),
    ...(theme === "purple" ? tokens(block(':root[data-theme="purple"]')) : {}),
  };
  const pairs = [
    ["brand", "brand-soft"],
    ["app-text", "app-bg"],
    ["app-muted", "app-bg"],
    ["app-subtle", "app-surface"],
    ["positive", "app-surface"],
    ["danger", "app-surface"],
    ["warning", "app-surface"],
    ["white", "brand"],
  ];
  for (const [foreground, background] of pairs) {
    const light = [
      luminance(foreground === "white" ? "#ffffff" : colors[foreground]),
      luminance(colors[background]),
    ].sort((a, b) => b - a);
    expect(
      (light[0] + 0.05) / (light[1] + 0.05),
      `${theme}: ${foreground}/${background}`,
    ).toBeGreaterThanOrEqual(4.5);
  }
});
