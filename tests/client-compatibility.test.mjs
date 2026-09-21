import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { pathToFileURL, URL } from "node:url";
import { checkJavaScript } from "../scripts/check-client-compatibility.mjs";

test("rejects the two production WKWebView parse failures", () => {
  assert.throws(() => checkJavaScript("const email = /(?<=^|\\s)a@b/g;"), /lookbehind/u);
  assert.throws(() => checkJavaScript("const email = /(?<!a)b/;"), /lookbehind/u);
  assert.throws(() => checkJavaScript("class C { static { this.x = 1; } }"), /static block/u);
  assert.throws(() => checkJavaScript("const r = /[a&&b]/v;"));
});

test("allows supported regex and ignores syntax mentioned in text", () => {
  checkJavaScript('const r = /(^|\\s|\\p{P})(foo)/gu; const example = "(?<=foo)";');
});

test("patched GFM transform preserves boundaries and rejected email candidates", async () => {
  let require = createRequire(new URL("../apps/web/package.json", import.meta.url));
  for (const name of ["remark-gfm", "mdast-util-gfm"]) {
    require = createRequire(require.resolve(name));
  }
  const module = await import(pathToFileURL(require.resolve("mdast-util-gfm-autolink-literal")));
  const transform = module.gfmAutolinkLiteralFromMarkdown().transforms[0];
  for (const [input, expected] of [
    ["a@b.com", ["a@b.com"]],
    ["(a@b.com)，c@d.org e@f.net", ["a@b.com", "c@d.org", "e@f.net"]],
    ["/a@b.com", []],
    ["汉a@b.com", []],
    ["a@b.123", []],
  ]) {
    const tree = {
      type: "root",
      children: [{ type: "paragraph", children: [{ type: "text", value: input }] }],
    };
    transform(tree);
    const children = tree.children[0].children;
    assert.deepEqual(
      children.filter((node) => node.type === "link").map((node) => node.url),
      expected.map((email) => `mailto:${email}`),
    );
    assert.equal(children.map((node) => node.value ?? node.children[0].value).join(""), input);
  }
});
