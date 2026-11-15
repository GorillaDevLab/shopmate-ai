import { ServiceUnavailableException } from "@nestjs/common";

export interface RuntimeTransactionClient {
  query(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
}
export function runtimeUnavailable(): ServiceUnavailableException {
  return new ServiceUnavailableException("Event runtime unavailable");
}

/** The owner invalidates this handle before draining, rollback and pool release. */
export class EventTransactionLifetime {
  private open = true;
  private failed = false;
  private readonly pending = new Set<Promise<void>>();
  readonly client: RuntimeTransactionClient;
  constructor(
    raw: RuntimeTransactionClient,
    private readonly live: () => boolean,
  ) {
    this.client = { query: (sql, values) => this.query(raw, sql, values) };
  }
  isActive = (): boolean => this.open && !this.failed && this.live();
  close(): void {
    this.open = false;
  }
  private query(raw: RuntimeTransactionClient, sql: string, values?: unknown[]) {
    if (!this.isActive()) return Promise.reject(runtimeUnavailable());
    const result = Promise.resolve().then(() => raw.query(sql, values));
    const drained = result.then(
      () => undefined,
      () => {
        this.failed = true;
      },
    );
    this.pending.add(drained);
    void drained.then(() => this.pending.delete(drained));
    return result;
  }
  async drain(): Promise<void> {
    while (this.pending.size > 0) await Promise.all([...this.pending]);
    if (this.failed) throw runtimeUnavailable();
  }
}
