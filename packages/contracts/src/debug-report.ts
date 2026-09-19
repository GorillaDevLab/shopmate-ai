import { z } from "zod";

// Kept self-contained so the same sanitizer can run in the pre-hydration script.
export function sanitizeDebugData(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[TRUNCATED]";
  if (typeof value === "string")
    return value
      .slice(0, 3000)
      .replace(/https?:\/\/[^\s<>"']+/gi, (raw) => {
        try {
          const url = new URL(raw);
          url.username = "";
          url.password = "";
          url.hash = "";
          url.searchParams.forEach((_, key) => url.searchParams.set(key, "REDACTED"));
          return url.toString();
        } catch {
          return "[INVALID URL]";
        }
      })
      .replace(/\b(?:Bearer|Basic)\s+[^\s,;]+/gi, "[REDACTED]")
      .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?/g, "[REDACTED]")
      .replace(/\b(?:sk-|re_)[A-Za-z0-9_-]{8,}/g, "[REDACTED]")
      .replace(
        /(["']?(?:password|passwd|token|accessToken|refreshToken|authorization|apiKey|api_key|secret|cookie|session|code|key)["']?\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&]+)/gi,
        "$1[REDACTED]",
      )
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[EMAIL]")
      .replace(/\b(?:\d[ -]?){11,19}\b/g, "[NUMBER]");
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (Array.isArray(value))
    return value.slice(-60).map((item) => sanitizeDebugData(item, depth + 1));
  if (typeof value !== "object") return "[UNSUPPORTED]";
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).slice(0, 60)) {
    if (
      /password|passwd|token|authorization|api.?key|secret|cookie|session|jwt|credit|cardnumber|email|phone|address|customer|username/i.test(
        key,
      )
    )
      result[key] = "[REDACTED]";
    else if (!["__proto__", "constructor", "prototype"].includes(key)) {
      try {
        result[key] = sanitizeDebugData((value as Record<string, unknown>)[key], depth + 1);
      } catch {
        result[key] = "[UNREADABLE]";
      }
    }
  }
  return result;
}

const text = z.string().max(3000);
export const DebugReportSchema = z.strictObject({
  description: z.string().max(1000),
  device: z.enum(["iPhone", "iPad", "Android", "Desktop"]),
  info: z.record(z.string().max(80), text).refine((v) => Object.keys(v).length <= 40),
  logs: z
    .array(
      z.strictObject({
        time: text,
        type: z.enum([
          "error",
          "rejection",
          "console",
          "network",
          "resource",
          "security",
          "storage",
        ]),
        detail: text,
      }),
    )
    .max(60),
});
