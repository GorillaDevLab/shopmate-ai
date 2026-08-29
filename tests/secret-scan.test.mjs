import assert from "node:assert/strict";
import test from "node:test";
import { scanText } from "../scripts/secret-scan.mjs";

test("Secret 扫描接受示例占位符", () => {
  assert.deepEqual(scanText("DEEPSEEK_API_KEY=your-deepseek-api-key"), []);
});

test("Secret 扫描拒绝疑似 API Token 并隐藏原文", () => {
  const key = ["sk-demo-", "12345678901234567890"].join("");
  const findings = scanText(`DEEPSEEK_API_KEY="${key}"`);

  assert.equal(findings.length, 1);
  assert.match(findings[0], /API key/);
  assert.doesNotMatch(findings[0], /1234567890/);
});
