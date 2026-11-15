export interface EventRuntimeEnvironment {
  readonly databaseUrl: string;
}

/** Dedicated capability only; a missing or invalid URL leaves unrelated startup available. */
export function eventRuntimeEnvironment(env: NodeJS.ProcessEnv): EventRuntimeEnvironment | null {
  const value = env.EVENT_DECISION_DATABASE_URL;
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
    return { databaseUrl: value };
  } catch {
    return null;
  }
}
