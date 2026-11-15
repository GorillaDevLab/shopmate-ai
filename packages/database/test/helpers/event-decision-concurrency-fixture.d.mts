import type pg from "pg";
export function childDatabase<T>(
  action: (state: { admin: pg.Client; url: URL }) => Promise<T>,
): Promise<void>;
export function migrate(admin: pg.Client): Promise<void>;
export function tenantEnvironment(
  inherited: NodeJS.ProcessEnv,
  isolatedUrl: string,
  runtimeUrl: string,
  metrics: {
    METRIC_DATABASE_URL: string;
    METRIC_DEFINITION_DATABASE_URL: string;
    EVENT_DECISION_DATABASE_URL: string;
  },
): NodeJS.ProcessEnv;
