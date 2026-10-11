import { MockConnectorError, type PersistentReadPort } from "@shopmate/api/mock-commerce";
import type { ReadOptions, ConnectorFailureCode } from "@shopmate/contracts";
import {
  SourceStorageError,
  type BoundSourceReadPort,
} from "@shopmate/database/mock-platform-read";
import { CheckpointReadPort } from "./checkpoint-read.js";

const failures: Readonly<Record<SourceStorageError["code"], ConnectorFailureCode>> = {
  SOURCE_INPUT: "INVALID_INPUT",
  SOURCE_INTEGRITY: "INVALID_RESPONSE",
  SOURCE_ABORTED: "ABORTED",
  SOURCE_DEADLINE: "TIMEOUT",
  SOURCE_STORAGE: "TEMPORARY",
  SOURCE_CONFIGURATION: "INVALID_RESPONSE",
  SOURCE_CREDENTIALS: "INVALID_RESPONSE",
};
export function commerceFailure(error: unknown): MockConnectorError {
  if (error instanceof MockConnectorError) return error;
  if (error instanceof SourceStorageError) return new MockConnectorError(failures[error.code]);
  if (error instanceof Error && error.message === "SYNC_RESULT_INVALID")
    return new MockConnectorError("INVALID_RESPONSE");
  return new MockConnectorError("TEMPORARY");
}

/** Checkpoint recovery retains its absolute budget before source failures become connector DTOs. */
export class CommerceReadPort implements PersistentReadPort {
  private readonly checkpoint: CheckpointReadPort;
  constructor(reader: BoundSourceReadPort) {
    this.checkpoint = new CheckpointReadPort(reader);
  }
  async read(request: unknown, options: ReadOptions): Promise<unknown | null> {
    try {
      return await this.checkpoint.read(request, options);
    } catch (error) {
      throw commerceFailure(error);
    }
  }
}
