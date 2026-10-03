import {
  ReadOptionsSchema,
  type ConnectorFailureCode,
  type ConnectorResult,
  type ReadOptions,
} from "@shopmate/contracts";

export class MockConnectorError extends Error {
  constructor(readonly code: ConnectorFailureCode) {
    super(code);
    this.name = "MockConnectorError";
  }
}

export function mockFailure(code: ConnectorFailureCode): ConnectorResult<never> {
  return Object.freeze({ ok: false, error: Object.freeze({ code, retryAfterMs: null }) });
}

function parseOptions(input: unknown): ConnectorResult<ReadOptions> {
  if (input === null || typeof input !== "object") return mockFailure("INVALID_INPUT");
  const { signal, ...json } = input as Record<string, unknown>;
  if (signal !== undefined && !(signal instanceof AbortSignal)) return mockFailure("INVALID_INPUT");
  const parsed = ReadOptionsSchema.safeParse(json);
  return parsed.success
    ? { ok: true, data: { ...parsed.data, signal } }
    : mockFailure("INVALID_INPUT");
}

class CallGate {
  readonly controller = new AbortController();
  readonly failure: Promise<ConnectorResult<never>>;
  readonly deadline: number;
  private code: ConnectorFailureCode | null = null;
  private resolveFailure!: (value: ConnectorResult<never>) => void;
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly onAbort = () => this.fail("ABORTED");

  constructor(private readonly caller: ReadOptions) {
    this.deadline = Math.min(Date.parse(caller.deadlineAt), Date.now() + 30_000);
    this.failure = new Promise((resolve) => {
      this.resolveFailure = resolve;
    });
    caller.signal?.addEventListener("abort", this.onAbort, { once: true });
    this.timer = setTimeout(() => this.fail("TIMEOUT"), Math.max(0, this.deadline - Date.now()));
  }

  currentFailure(): ConnectorResult<never> | null {
    if (this.caller.signal?.aborted) this.fail("ABORTED");
    if (Date.now() >= this.deadline) this.fail("TIMEOUT");
    return this.code ? mockFailure(this.code) : null;
  }

  options(): ReadOptions {
    return Object.freeze({
      ...this.caller,
      deadlineAt: new Date(this.deadline).toISOString(),
      signal: this.controller.signal,
    });
  }

  close(): void {
    clearTimeout(this.timer);
    this.caller.signal?.removeEventListener("abort", this.onAbort);
  }

  private fail(code: ConnectorFailureCode): void {
    if (this.code) return;
    this.code = code;
    this.controller.abort();
    this.resolveFailure(mockFailure(code));
  }
}

/** Async work is raced; CPU-bound source generation is checked again before returning data. */
export async function executeMockRead<T>(
  input: unknown,
  operation: (options: ReadOptions) => Promise<ConnectorResult<T>>,
): Promise<ConnectorResult<T>> {
  const parsed = parseOptions(input);
  if (!parsed.ok) return parsed;
  const gate = new CallGate(parsed.data);
  try {
    const before = gate.currentFailure();
    if (before) return before;
    const result = await Promise.race([gate.failure, operation(gate.options())]);
    return gate.currentFailure() ?? result;
  } catch (error) {
    return (
      gate.currentFailure() ??
      mockFailure(error instanceof MockConnectorError ? error.code : "TEMPORARY")
    );
  } finally {
    gate.close();
  }
}
