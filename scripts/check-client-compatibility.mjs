import { readFile, readdir } from "node:fs/promises";
import process from "node:process";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "acorn";

export function checkJavaScript(source, filename = "client.js") {
  const tree = parse(source, { ecmaVersion: 2022, sourceType: "module" });
  const pending = [tree];
  while (pending.length) {
    const node = pending.pop();
    if (node.type === "StaticBlock") {
      throw new Error(`${filename}: class static block requires Safari 16.4`);
    }
    if (node.regex && /\(\?<[=!]/u.test(node.regex.pattern)) {
      throw new Error(`${filename}: RegExp lookbehind requires Safari 16.4`);
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) pending.push(...value.filter((item) => item?.type));
      else if (value?.type) pending.push(value);
    }
  }
}

async function checkDirectory(directory) {
  let count = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) count += await checkDirectory(path);
    else if (entry.name.endsWith(".js")) {
      checkJavaScript(await readFile(path, "utf8"), path);
      count++;
    }
  }
  return count;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = resolve(process.env.NEXT_DIST_DIR || ".next", "static");
  const count = await checkDirectory(directory);
  if (!count) throw new Error("No client JavaScript found for compatibility verification");
  process.stdout.write(`Checked ${count} client bundles: no lookbehind or static blocks.\n`);
}
