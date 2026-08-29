import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const ignoredFiles = new Set([".env.example"]);
const binaryExtensions = /\.(?:png|jpg|jpeg|gif|ico|woff2?|ttf|pdf)$/i;
const patterns = [
  { name: "API key", expression: /\b(?:sk|pk)-[A-Za-z0-9_-]{20,}\b/g },
  {
    name: "credential assignment",
    expression: /\b(?:api[_-]?key|token|secret)\s*[:=]\s*["'][A-Za-z0-9_\-/+=]{16,}["']/gi,
  },
];

export function scanText(text) {
  const findings = [];
  for (const pattern of patterns) {
    pattern.expression.lastIndex = 0;
    if (pattern.expression.test(text)) findings.push(pattern.name);
  }
  return findings;
}

export function scanTrackedFiles() {
  const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
  const findings = [];
  for (const file of files) {
    if (ignoredFiles.has(file) || binaryExtensions.test(file)) continue;
    const matches = scanText(readFileSync(file, "utf8"));
    matches.forEach((rule) => findings.push(`${file}: ${rule}`));
  }
  return findings;
}

if (import.meta.main) {
  const findings = scanTrackedFiles();
  if (findings.length > 0) {
    console.error("Secret 扫描失败：发现疑似凭据（未显示 Secret 原文）");
    findings.forEach((finding) => console.error(`✗ ${finding}`));
    process.exitCode = 1;
  } else {
    console.log("Secret 扫描通过：未发现疑似凭据。");
  }
}
