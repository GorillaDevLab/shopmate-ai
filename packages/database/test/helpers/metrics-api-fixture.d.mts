import type { ConnectorBinding, MetricWindow } from "@shopmate/contracts";
export const binding: ConnectorBinding;
export const scope: ConnectorBinding & { readonly sessionId: string; readonly generation: number };
export const window: MetricWindow;
export const cutoff: string;
export class MetricsApiFixture {
  constructor(url: string);
  initialize(): Promise<void>;
  seed(until?: string, correction?: boolean): Promise<void>;
  advance(at: string): Promise<void>;
  counts(): Promise<{ archives: number; snapshots: number; definitions: number }>;
  membership(active: boolean): Promise<void>;
  conflictDefinition(): Promise<ConnectorBinding>;
  sourceFailure<T>(action: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
