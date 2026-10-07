import type pg from "pg";
import { verifyCredentials, type SourcePool } from "./clients.js";
import { SourceStorageError, transactionFailure } from "./errors.js";
import { ReadControl } from "./read-control.js";
import { configureTransaction } from "./transaction.js";
import type { SourceReadControl } from "./types.js";

class Checkout {
  client?: pg.PoolClient;
  begun = false;
  discard = false;
  released = false;
  cancellation?: Promise<void>;
  private readonly onError = () => {
    this.discard = true;
  };
  bind(client: pg.PoolClient, control: ReadControl, pool: SourcePool): void {
    this.client = client;
    client.on("error", this.onError);
    // Signal the backend before destroying its connection: PostgreSQL need not
    // observe a disconnected socket while blocked in SQL or a lock wait.
    control.bind(() => {
      this.cancellation ??= this.cancel(pool, client);
    });
  }
  private async cancel(pool: SourcePool, client: pg.PoolClient): Promise<void> {
    try {
      await pool.cancelRead?.(client);
    } catch {
      this.discard = true;
    } finally {
      this.release(true);
    }
  }
  release(destroy: boolean): void {
    if (!this.client || this.released) return;
    this.released = true;
    this.client.release(destroy);
  }
  async rollback(): Promise<void> {
    if (this.client && this.begun && !this.released)
      this.discard = (await rollback(this.client)) || this.discard;
  }
  close(): void {
    this.release(this.discard);
    this.client?.off("error", this.onError);
  }
  failure(error: unknown): Error {
    return this.discard
      ? new SourceStorageError("SOURCE_STORAGE")
      : transactionFailure(error, ["DENIED"]);
  }
}

export async function readTransaction<T>(
  pool: SourcePool,
  action: (client: pg.PoolClient) => Promise<T>,
  rollbackWhen: (result: T) => boolean = () => false,
  input?: SourceReadControl,
): Promise<T> {
  const control = new ReadControl(input);
  const checkout = new Checkout();
  try {
    const client = await control.acquire(pool);
    checkout.bind(client, control, pool);
    await verifyCredentials(client, "reader");
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    checkout.begun = true;
    await configureTransaction(client);
    const result = await action(client);
    control.check();
    if (checkout.discard) throw new SourceStorageError("SOURCE_STORAGE");
    await client.query(rollbackWhen(result) ? "ROLLBACK" : "COMMIT");
    checkout.begun = false;
    control.check();
    if (checkout.discard) throw new SourceStorageError("SOURCE_STORAGE");
    return result;
  } catch (error) {
    await checkout.cancellation;
    await checkout.rollback();
    throw control.error() ?? checkout.failure(error);
  } finally {
    control.close();
    checkout.close();
  }
}
async function rollback(client: pg.PoolClient): Promise<boolean> {
  try {
    await client.query("ROLLBACK");
    return false;
  } catch {
    return true;
  }
}
