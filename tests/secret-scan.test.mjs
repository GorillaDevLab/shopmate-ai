import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { scanText, scanTrackedFiles } from "../scripts/secret-scan.mjs";

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

test("Secret 扫描识别 GitHub Token 格式", () => {
  const token = ["ghp_", "12345678901234567890"].join("");
  assert.deepEqual(scanText(`说明文本 ${token}`), ["API key"]);
});

test("扫描追踪文件时返回失败规则但不泄露 Secret", () => {
  const directory = mkdtempSync(join(tmpdir(), "shopmate-secret-test-"));
  const file = join(directory, "fixture.txt");
  const key = ["ghp_", "12345678901234567890"].join("");
  writeFileSync(file, `TOKEN=${key}`);

  try {
    const findings = scanTrackedFiles([file]);
    assert.deepEqual(findings, [`${file}: API key`, `${file}: credential assignment`]);
    assert.doesNotMatch(findings.join(" "), /1234567890/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
