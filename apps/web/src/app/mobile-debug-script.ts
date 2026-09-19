import { sanitizeDebugData } from "@shopmate/contracts";

export function mobileDebugScript() {
  const app = {
    version: "0.1.0",
    environment: process.env.NODE_ENV,
    build: process.env.NEXT_PUBLIC_APP_BUILD ?? "unknown",
  };
  return `(${installMobileDebug.toString()})(${sanitizeDebugData.toString()},${JSON.stringify(app).replace(/</g, "\\u003c")});`;
}

// Self-contained: this runs before React so hydration failure cannot remove reporting.
function installMobileDebug(sanitize: (value: unknown) => unknown, app: Record<string, string>) {
  type Log = { time: string; type: string; detail: string };
  const logs: Log[] = [];
  const originalFetch = window.fetch;
  // eslint-disable-next-line no-console -- Capture the original console method for diagnostic wrapping.
  const originalConsole = console.error;
  function record(type: string, value: unknown) {
    try {
      const detail = JSON.stringify(sanitize(value)).slice(0, 700);
      logs.push({ time: new Date().toISOString(), type, detail });
      if (logs.length > 60) logs.shift();
    } catch {
      /* Diagnostics must never interrupt the application. */
    }
  }
  function errorData(reason: unknown) {
    if (reason instanceof Error)
      return { name: reason.name, message: reason.message, stack: reason.stack };
    return typeof reason === "string" ? reason : "Non-Error rejection (contents omitted)";
  }
  function safeUrl(raw: string) {
    try {
      return sanitize(new URL(raw, location.href).toString());
    } catch {
      return "[INVALID URL]";
    }
  }
  window.addEventListener(
    "error",
    (event: Event) => {
      if (event instanceof ErrorEvent)
        record("error", {
          message: event.message,
          file: safeUrl(event.filename),
          line: event.lineno,
          column: event.colno,
          error: errorData(event.error),
        });
      else
        record("resource", {
          element: (event.target as Element | null)?.tagName,
          url: safeUrl((event.target as HTMLScriptElement | null)?.src ?? ""),
        });
    },
    true,
  );
  window.addEventListener("unhandledrejection", (event) =>
    record("rejection", errorData(event.reason)),
  );
  window.addEventListener("securitypolicyviolation", (event) =>
    record("security", { directive: event.violatedDirective, blocked: safeUrl(event.blockedURI) }),
  );
  // eslint-disable-next-line no-console -- Diagnostics intentionally wrap console.error without emitting logs.
  console.error = function (...args: unknown[]) {
    record("console", args.slice(0, 5).map(errorData));
    originalConsole.apply(console, args);
  };
  if (originalFetch)
    window.fetch = function (input, init) {
      const started = Date.now();
      const request =
        typeof Request !== "undefined" && input instanceof Request ? input : undefined;
      const url = safeUrl(request?.url ?? String(input));
      const method = init?.method ?? request?.method ?? "GET";
      return originalFetch.call(window, input, init).then(
        (response) => {
          if (!response.ok)
            record("network", {
              url,
              method,
              status: response.status,
              statusText: response.statusText,
              duration: Date.now() - started,
              response: "Body omitted to protect customer and authentication data",
            });
          return response;
        },
        (reason: unknown) => {
          record("network", {
            url,
            method,
            duration: Date.now() - started,
            error: errorData(reason),
            online: navigator.onLine,
          });
          throw reason;
        },
      );
    };
  function storageKeys(kind: "localStorage" | "sessionStorage") {
    try {
      const storage = window[kind];
      const keys = Array.from({ length: Math.min(storage.length, 30) }, (_, i) => storage.key(i));
      return JSON.stringify(sanitize(keys));
    } catch (reason) {
      record("storage", { kind, error: errorData(reason) });
      return "Unavailable";
    }
  }
  function snapshot(description: string) {
    const ua = navigator.userAgent;
    const device = /iPhone/i.test(ua)
      ? "iPhone"
      : /iPad/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)
        ? "iPad"
        : /Android/.test(ua)
          ? "Android"
          : "Desktop";
    let timezone = "Unavailable";
    try {
      timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      timezone = "Unavailable";
    }
    const info = {
      url: String(safeUrl(location.href)),
      pathname: String(sanitize(location.pathname)),
      query: location.search ? "Values redacted; see URL" : "",
      referrer: String(safeUrl(document.referrer)),
      title: document.title,
      userAgent: ua,
      platform: navigator.platform,
      language: navigator.language,
      languages: String(navigator.languages ?? []),
      online: String(navigator.onLine),
      cookiesEnabled: String(navigator.cookieEnabled),
      secureContext: String(window.isSecureContext),
      viewport: `${innerWidth} x ${innerHeight}`,
      screen: `${screen.width} x ${screen.height}`,
      pixelRatio: String(devicePixelRatio),
      orientation: screen.orientation?.type ?? "Unavailable",
      localTime: new Date().toString(),
      utc: new Date().toISOString(),
      timezone,
      browser: /Edg/i.test(ua)
        ? "Edge"
        : /Firefox|FxiOS/i.test(ua)
          ? "Firefox"
          : /Chrome|CriOS/i.test(ua)
            ? "Chrome"
            : /Safari/i.test(ua)
              ? "Safari"
              : "WebView/Unknown",
      localKeys: storageKeys("localStorage"),
      temporaryKeys: storageKeys("sessionStorage"),
      ...app,
    };
    const boundedInfo = Object.fromEntries(
      Object.entries(info).map(([key, value]) => [key, value.slice(0, 500)]),
    );
    const report = {
      description: String(sanitize(description)),
      device,
      info: sanitize(boundedInfo),
      logs: logs.slice(),
    };
    while (report.logs.length && new Blob([JSON.stringify(report)]).size > 60000)
      report.logs.shift();
    return report;
  }
  function mount() {
    let enabled = true;
    try {
      enabled = window.localStorage.getItem("shopmate_debug_enabled") !== "false";
    } catch {
      enabled = true;
    }
    if (!enabled) return;
    const host = document.createElement("div");
    host.id = "mobile-debug-report";
    const root = host.attachShadow ? host.attachShadow({ mode: "open" }) : host;
    root.innerHTML = `<style>
      :host{position:fixed;right:12px;bottom:calc(88px + env(safe-area-inset-bottom,0px));z-index:2147483646;font:14px system-ui;color:#202033}
      button{font:inherit;min-height:44px;border:1px solid #666;border-radius:12px;background:#fff;color:#202033;padding:8px 14px;touch-action:manipulation}
      #panel{position:fixed;inset:auto 12px calc(144px + env(safe-area-inset-bottom,0px));max-height:65vh;overflow:auto;background:#fff;border:1px solid #aaa;border-radius:16px;padding:16px;box-shadow:0 8px 32px #0004}
      #details{white-space:pre-wrap;word-break:break-word;max-height:38vh;overflow:auto;background:#f5f5f8;border-radius:10px;padding:10px;font:12px ui-monospace,monospace;line-height:1.45}
      p{line-height:1.5}button:disabled{opacity:.6}
      @media(min-width:1025px) and (hover:hover) and (pointer:fine){:host{display:none}}
    </style><button id="open" type="button" aria-label="打开页面诊断">诊断</button>
    <section id="panel" hidden role="dialog" aria-label="页面诊断"><h2>页面诊断</h2>
    <p>请截图或复制下面的信息发给开发者。不会发送邮箱，也不会读取密码或业务数据。</p>
    <pre id="details"></pre><button id="copy" type="button">复制诊断信息</button>
    <button id="disable" type="button">关闭诊断入口</button> <button id="close" type="button">关闭</button><p id="status" role="status" aria-live="polite"></p></section>`;
    const panel = root.querySelector<HTMLElement>("#panel")!;
    const details = root.querySelector<HTMLElement>("#details")!;
    const open = root.querySelector<HTMLButtonElement>("#open")!;
    const copy = root.querySelector<HTMLButtonElement>("#copy")!;
    const disable = root.querySelector<HTMLButtonElement>("#disable")!;
    const status = root.querySelector<HTMLElement>("#status")!;
    function render() {
      details.textContent = JSON.stringify(snapshot(""), null, 2);
    }
    open.onclick = () => {
      panel.hidden = false;
      render();
      copy.focus();
    };
    root.querySelector<HTMLButtonElement>("#close")!.onclick = () => {
      panel.hidden = true;
      open.focus();
    };
    copy.onclick = () => {
      const text = details.textContent ?? "";
      const clipboard = navigator.clipboard;
      if (!clipboard?.writeText) {
        status.textContent = "请直接截图发送给开发者";
        return;
      }
      void clipboard.writeText(text).then(
        () => (status.textContent = "已复制诊断信息，请发送给开发者"),
        () => (status.textContent = "请直接截图发送给开发者"),
      );
    };
    disable.onclick = () => {
      try {
        window.localStorage.setItem("shopmate_debug_enabled", "false");
      } catch {
        /* A storage failure must not block the temporary diagnostic panel. */
      }
      panel.hidden = true;
      open.hidden = true;
      status.textContent = "诊断入口已关闭，刷新页面后生效";
    };
    panel.onkeydown = (event) => {
      if (event.key === "Escape") {
        panel.hidden = true;
        open.focus();
      }
    };
    document.body.appendChild(host);
    // Native dialogs live above every z-index; keep reporting reachable inside them.
    if (typeof MutationObserver === "function") {
      const observer = new MutationObserver(() => {
        if (typeof document === "undefined") return;
        const dialogs = document.querySelectorAll("dialog[open]");
        const parent = dialogs.length ? dialogs[dialogs.length - 1]! : document.body;
        if (host.parentElement !== parent) parent.appendChild(host);
      });
      observer.observe(document.body, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ["open"],
      });
      window.addEventListener("pagehide", () => observer.disconnect(), { once: true });
    }
  }
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", mount, { once: true });
  else mount();
}
