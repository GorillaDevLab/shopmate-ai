import { types } from "node:util";
import { ReadOptionsSchema, type ReadOptions } from "@shopmate/contracts";
import { SourceStorageError } from "@shopmate/database/mock-platform-read";
import type { BoundSourceReadPort } from "@shopmate/database/mock-platform-read";

type ReadControl = Parameters<BoundSourceReadPort["read"]>[1];
interface CheckpointReader {
  read(request: unknown, control?: ReadControl): Promise<unknown | null>;
  refreshCheckpoint(request: unknown, control?: ReadControl): Promise<string | null>;
}

function dataRecord(input: unknown): Record<string, unknown> {
  if (
    !input ||
    typeof input !== "object" ||
    types.isProxy(input) ||
    Object.getPrototypeOf(input) !== Object.prototype
  )
    throw new SourceStorageError("SOURCE_INPUT");
  for (const key of Reflect.ownKeys(input)) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (
      typeof key !== "string" ||
      !descriptor ||
      !("value" in descriptor) ||
      !descriptor.enumerable
    )
      throw new SourceStorageError("SOURCE_INPUT");
  }
  return { ...input };
}

function snapshotRequest(input: unknown): Readonly<Record<string, unknown>> {
  const request = dataRecord(input);
  if (request.entityKey !== undefined) {
    const tuple = request.entityKey;
    if (
      !Array.isArray(tuple) ||
      types.isProxy(tuple) ||
      Object.getPrototypeOf(tuple) !== Array.prototype ||
      tuple.length < 2 ||
      tuple.length > 3 ||
      Reflect.ownKeys(tuple).length !== tuple.length + 1
    )
      throw new SourceStorageError("SOURCE_INPUT");
    const copied: string[] = [];
    for (let index = 0; index < tuple.length; index++) {
      const entry = Object.getOwnPropertyDescriptor(tuple, String(index));
      if (!entry || !("value" in entry) || typeof entry.value !== "string")
        throw new SourceStorageError("SOURCE_INPUT");
      copied.push(entry.value);
    }
    request.entityKey = Object.freeze(copied);
  }
  return Object.freeze(request);
}

function sourceControl(input: ReadOptions) {
  const { signal, ...json } = dataRecord(input);
  const parsed = ReadOptionsSchema.safeParse(json);
  if (!parsed.success || (signal !== undefined && !(signal instanceof AbortSignal)))
    throw new SourceStorageError("SOURCE_INPUT");
  return Object.freeze({
    deadlineAt: new Date(
      Math.min(Date.parse(parsed.data.deadlineAt), Date.now() + 25_000),
    ).toISOString(),
    ...(signal ? { signal } : {}),
  });
}

function checkControl(control: ReturnType<typeof sourceControl>): void {
  if (control.signal?.aborted) throw new SourceStorageError("SOURCE_ABORTED");
  if (Date.now() >= Date.parse(control.deadlineAt)) throw new SourceStorageError("SOURCE_DEADLINE");
}

export class CheckpointReadPort {
  constructor(private readonly reader: CheckpointReader) {}

  async read(input: unknown, options: ReadOptions): Promise<unknown | null> {
    const request = snapshotRequest(input),
      control = sourceControl(options);
    checkControl(control);
    try {
      const page = await this.reader.read(request, control);
      checkControl(control);
      return page;
    } catch (error) {
      if (
        !(error instanceof SourceStorageError) ||
        error.code !== "SOURCE_INPUT" ||
        typeof request.cursor !== "string"
      )
        throw error;
    }
    // Recovery changes only credential expiry; the durable business cursor changes at page commit.
    checkControl(control);
    const cursor = await this.reader.refreshCheckpoint(request, control);
    checkControl(control);
    if (cursor === null) return null;
    const page = await this.reader.read({ ...request, cursor }, control);
    checkControl(control);
    return page;
  }
}
