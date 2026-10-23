export interface MetricsEnvironment {
  readonly databaseUrl: string;
  readonly definitionUrl: string | null;
  readonly cursorSecret: Buffer;
}
function databaseUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (
      !["postgres:", "postgresql:"].includes(url.protocol) ||
      !url.hostname ||
      !url.username ||
      ["postgres", "root"].includes(url.username) ||
      url.pathname.length < 2 ||
      url.search ||
      url.hash
    )
      return null;
    return value;
  } catch {
    return null;
  }
}
/** Explicit configuration only: membership DATABASE_URL is never a metric fallback. */
export function metricEnvironment(env: NodeJS.ProcessEnv): MetricsEnvironment | null {
  const url = databaseUrl(env.METRIC_DATABASE_URL);
  const key = env.METRIC_CURSOR_SECRET;
  const definitionUrl = databaseUrl(env.METRIC_DEFINITION_DATABASE_URL);
  if (
    !url ||
    !key ||
    Buffer.byteLength(key, "utf8") < 32 ||
    (env.METRIC_DEFINITION_DATABASE_URL && !definitionUrl)
  )
    return null;
  if (definitionUrl) {
    const runtime = new URL(url),
      definition = new URL(definitionUrl);
    if (
      definition.username === runtime.username ||
      definition.hostname !== runtime.hostname ||
      (definition.port || "5432") !== (runtime.port || "5432") ||
      definition.pathname !== runtime.pathname
    )
      return null;
  }
  return { databaseUrl: url, definitionUrl, cursorSecret: Buffer.from(key, "utf8") };
}
