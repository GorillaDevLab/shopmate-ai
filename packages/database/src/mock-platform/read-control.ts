import type pg from "pg";
import type { SourcePool } from "./clients.js";
import { SourceStorageError } from "./errors.js";
import type { SourceReadControl } from "./types.js";

function readDeadline(control: SourceReadControl): number {
  if (
    !control ||
    typeof control !== "object" ||
    Array.isArray(control) ||
    (control.signal !== undefined && !(control.signal instanceof AbortSignal))
  )
    throw new SourceStorageError("SOURCE_INPUT");
  const value = control.deadlineAt;
  if (value === undefined) return Date.now() + 30_000;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value))
    throw new SourceStorageError("SOURCE_INPUT");
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value)
    throw new SourceStorageError("SOURCE_INPUT");
  return Math.min(parsed, Date.now() + 30_000);
}

export class ReadControl {
  private readonly deadline: number;
  private readonly timer: ReturnType<typeof setTimeout>;
  private failure?: SourceStorageError;
  private cancel?: () => void;
  private readonly abort = () => this.stop("SOURCE_ABORTED");

  constructor(private readonly input: SourceReadControl = {}) {
    this.deadline = readDeadline(input);
    if (input.signal?.aborted) throw new SourceStorageError("SOURCE_ABORTED");
    this.check();
    input.signal?.addEventListener("abort", this.abort, { once: true });
    this.timer = setTimeout(() => this.stop("SOURCE_DEADLINE"), this.deadline - Date.now());
  }
  private stop(code: "SOURCE_ABORTED" | "SOURCE_DEADLINE"): void {
    this.failure ??= new SourceStorageError(code);
    this.cancel?.();
  }
  check(): void {
    if (Date.now() >= this.deadline) this.failure ??= new SourceStorageError("SOURCE_DEADLINE");
    if (this.failure) throw this.failure;
  }
  async acquire(pool: SourcePool): Promise<pg.PoolClient> {
    this.check();
    return new Promise((resolve, reject) => {
      this.cancel = () => reject(this.failure);
      // pg's bounded acquisition cannot be removed through a public API. Drain its
      // result and release late checkout so cancellation never leaks a pool slot.
      pool.connect().then((client) => {
        if (this.failure) client.release();
        else resolve(client);
      }, reject);
    });
  }
  bind(cancel: () => void): void {
    this.cancel = cancel;
    if (this.failure) cancel();
    this.check();
  }
  error(): SourceStorageError | undefined {
    return this.failure;
  }
  close(): void {
    clearTimeout(this.timer);
    this.input.signal?.removeEventListener("abort", this.abort);
    this.cancel = undefined;
  }
}
