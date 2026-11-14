import type { ConnectorBinding, MetricWindow } from "@shopmate/contracts";
export const observedAt: string;
export const window: MetricWindow;
export const binding: ConnectorBinding;
export const scope: ConnectorBinding & { readonly sessionId: string; readonly generation: number };
export class EventDecisionsApiFixture {
  constructor(url: string);
  initialize(): Promise<void>;
  seed(at?: string, available?: number): Promise<void>;
  advance(at: string): Promise<void>;
  connectionGeneration(value: number): Promise<void>;
  query(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
  counts(): Promise<Record<string, number>>;
  close(): Promise<void>;
}
