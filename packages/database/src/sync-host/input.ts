export const streams = ["PRODUCTS", "ORDERS", "REFUNDS", "INVENTORY", "MARKETING"] as const;
export type SyncStream = (typeof streams)[number];
export function workerDatabaseUrl(env: NodeJS.ProcessEnv): string {
  const value = env.SYNC_WORKER_DATABASE_URL;
  if (!value) throw new Error("SYNC_WORKER_CONFIGURATION");
  try {
    const url = new URL(value);
    if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.username || !url.hostname)
      throw new Error("SYNC_WORKER_CONFIGURATION");
  } catch { throw new Error("SYNC_WORKER_CONFIGURATION"); }
  return value;
}
export function workerId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/u.test(value))
    throw new Error("SYNC_INPUT_INVALID");
  return value;
}
export function workerStream(value: unknown): SyncStream {
  if (!streams.includes(value as SyncStream)) throw new Error("SYNC_INPUT_INVALID");
  return value as SyncStream;
}
export function workerTime(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) ||
    !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value || value.startsWith("0000"))
    throw new Error("SYNC_INPUT_INVALID");
  return value;
}
export function workerCursor(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !value || Buffer.byteLength(value, "utf8") > 1024 || /[\p{Cc}\p{Cs}]/u.test(value))
    throw new Error("SYNC_INPUT_INVALID");
  return value;
}
function invalidRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const externalStoreId = (value as Record<string, unknown>).externalStoreId;
  if (typeof externalStoreId !== "string" || !externalStoreId || externalStoreId.length > 256 || /[\p{Cc}\p{Cs}]/u.test(externalStoreId)) return {};
  // Preserve the original namespace for the RPC's authority check; never adopt the Job's namespace.
  return { externalStoreId };
}
function safeRecord(value: unknown): unknown {
  try {
    const encoded = JSON.stringify(value, (key: string, item: unknown) => {
      if (key.includes(String.fromCharCode(0)) || /\p{Cs}/u.test(key)) throw new Error("INVALID_RECORD");
      if (typeof item === "string" && (item.includes(String.fromCharCode(0)) || /\p{Cs}/u.test(item))) throw new Error("INVALID_RECORD");
      if (typeof item === "number" && !Number.isSafeInteger(item)) throw new Error("INVALID_RECORD");
      if (typeof item === "bigint" || typeof item === "function" || typeof item === "symbol" || item === undefined) throw new Error("INVALID_RECORD");
      return item;
    });
    return encoded === undefined ? invalidRecord(value) : JSON.parse(encoded) as unknown;
  } catch { return invalidRecord(value); }
}
export function encodeWorkerPage(stream: SyncStream, value: unknown): string {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    const page = value as Record<string, unknown>;
    const keys = Object.keys(page).sort().join(",");
    if (keys !== "items,nextCursor,observedAt,sourceWatermark" || !Array.isArray(page.items) ||
      page.items.length > (stream === "ORDERS" ? 10 : 200)) throw new Error();
    const encoded = JSON.stringify({ items: page.items.map(safeRecord), nextCursor: workerCursor(page.nextCursor),
      observedAt: workerTime(page.observedAt), sourceWatermark: page.sourceWatermark === null ? null : workerTime(page.sourceWatermark) });
    if (Buffer.byteLength(encoded, "utf8") > 16 * 1024 * 1024) throw new Error();
    return encoded;
  } catch { throw new Error("SYNC_PAGE_INVALID"); }
}
