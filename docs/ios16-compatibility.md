# iOS 16.2 / WeChat compatibility

## Root causes

The production `2j6kl_bct0bwq.js` contains the email lookbehind from
`remark-gfm` → `mdast-util-gfm` → `mdast-util-gfm-autolink-literal@2.0.1`,
`lib/index.js`, `transformGfmAutolinkLiterals`.
The committed pnpm patch consumes and preserves the boundary as a capture group,
adjusting the email match offset before the existing boundary validation.
It keeps GFM tables, autolinks, and Markdown sanitization intact.

The production `3q-_ffqmbokp4.js` maps to Next.js client error-boundary/runtime
modules and was emitted by the default Turbopack production pipeline. The exact
URL currently returns valid JavaScript, but Next.js 16's documented browser floor
is Safari 16.4, so its default client output is not a supported artifact for the
required iOS 16.2 runtime. The coarse WebView location (`line 1, column 0`) does
not identify a single token reliably. The fix therefore targets the verified
build-level cause: emit the entire client through Webpack using the declared
Safari 16.2 browserslist, then reject known incompatible syntax in every chunk.
A runtime error handler or polyfill cannot repair a module that fails to parse.

At investigation time both exact URLs returned HTTP 200 and
`application/javascript; charset=UTF-8`, with actual Turbopack JavaScript.
No middleware/proxy file exists in this repository. Next's rewrite is restricted
to `/api/:path*`; it does not match static chunks. No evidence was found that these
two responses were authentication JSON. Live nginx configuration was not available.

## Build and deploy

- Install with `pnpm install --frozen-lockfile`; keep `patches/` in the checkout.
- Use `npm run build` or `pnpm build`, not a direct `next build`. The web build uses
  Webpack with explicit Safari/iOS 16.2 targets and verifies every emitted static JS
  file. The verifier rejects lookbehind, class static blocks, and post-ES2022 syntax
  (including the RegExp `v` flag). Acorn is build-only, not shipped to browsers.
- Deploy the whole matching `.next` output and restart the web process. Do not mix
  old HTML and new chunks. Reload the page in WeChat after deployment.
- The nginx example now explicitly routes `/_next/static/` to Next without auth
  subrequests or intercepted errors. Apply this if the live server has broader
  authentication/error rules. Check `nginx -t` before reloading. Do not add a JSON
  error handler or SPA HTML fallback to static assets. Keep `/_next/image`, favicon,
  and public assets outside any future application authentication matcher.
- HTTP was not the cause of these parse failures. HTTPS remains recommended for
  production; changing HTTPS alone would not fix unsupported JavaScript syntax.

## Verification boundaries

Run `node --test tests/client-compatibility.test.mjs`, the web unit tests, and a
fresh root production build. The build checker is a regression gate, not a full
emulator of Safari or CSS/runtime feature support. Tailwind 4 also targets newer
Safari; visual acceptance on the actual iOS 16.2 device is still required. Test
login, dashboard, Markdown tables/email links, charts, and scrolling in WeChat
without sending paid AI requests. No live database changes are needed.

Browser references:

- https://webkit.org/blog/13966/webkit-features-in-safari-16-4/
- https://github.com/vercel/next.js/blob/canary/docs/01-app/02-guides/upgrading/version-16.mdx
