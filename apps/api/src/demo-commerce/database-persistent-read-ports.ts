import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import {
  createMockSourceReadPorts,
  type SourceReadPorts,
} from "@shopmate/database/mock-platform-read";
import { MockConnectorError } from "../integrations/mock/mock-call.js";
import type {
  PersistentReadBinder,
  PersistentScope,
} from "../integrations/mock/persistent-read-port.js";

@Injectable()
export class DatabasePersistentReadPorts implements PersistentReadBinder, OnModuleDestroy {
  private ports?: SourceReadPorts;
  private closed = false;
  private closing?: Promise<void>;

  bind(actor: { readonly userId: string; readonly merchantId: string }, scope: PersistentScope) {
    try {
      if (this.closed) throw new MockConnectorError("TEMPORARY");
      this.ports ??= createMockSourceReadPorts(process.env);
      const port = this.ports.bind(actor, scope);
      return {
        read: async (request, options) => {
          try {
            return await port.read(request, {
              signal: options.signal,
              deadlineAt: options.deadlineAt,
            });
          } catch (error) {
            throw connectorError(error);
          }
        },
      } satisfies ReturnType<PersistentReadBinder["bind"]>;
    } catch (error) {
      throw connectorError(error);
    }
  }

  onModuleDestroy(): Promise<void> {
    this.closed = true;
    this.closing ??= this.ports?.close() ?? Promise.resolve();
    return this.closing;
  }
}

function connectorError(error: unknown): MockConnectorError {
  if (error instanceof MockConnectorError) return error;
  const code = error instanceof Error && "code" in error ? error.code : undefined;
  switch (code) {
    case "SOURCE_INPUT":
      return new MockConnectorError("INVALID_INPUT");
    case "SOURCE_ABORTED":
      return new MockConnectorError("ABORTED");
    case "SOURCE_DEADLINE":
      return new MockConnectorError("TIMEOUT");
    case "SOURCE_INTEGRITY":
      return new MockConnectorError("INVALID_RESPONSE");
    default:
      return new MockConnectorError("TEMPORARY");
  }
}
