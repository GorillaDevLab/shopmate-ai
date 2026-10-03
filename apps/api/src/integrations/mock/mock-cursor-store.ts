import { randomUUID } from "node:crypto";
import { MockConnectorError } from "./mock-call.js";

interface CursorEntry {
  readonly scanId: string;
  readonly lookupKey: string;
  readonly queryKey: string;
  readonly frameHash: string;
  readonly offset: number;
  readonly expiresAt: number;
}

/** Opaque handles locate server-held state; they never establish resource authorization. */
export class MockCursorStore {
  private readonly entries = new Map<string, CursorEntry>();
  private readonly reverse = new Map<string, string>();

  read(token: string, queryKey: string): CursorEntry {
    const entry = this.entries.get(token);
    if (!entry || entry.queryKey !== queryKey) throw new MockConnectorError("INVALID_INPUT");
    if (Date.now() >= entry.expiresAt) throw new MockConnectorError("CONFLICT");
    return entry;
  }

  next(queryKey: string, frameHash: string, offset: number, parent?: CursorEntry): string {
    const key = JSON.stringify([queryKey, frameHash, offset, parent?.scanId ?? null]);
    const existing = this.reverse.get(key);
    if (existing && this.entries.get(existing)!.expiresAt > Date.now()) return existing;
    if (existing) this.remove(existing);
    if (this.entries.size >= 256) this.remove(this.entries.keys().next().value!);
    const token = `mock-cursor:${randomUUID()}`;
    this.entries.set(
      token,
      Object.freeze({
        queryKey,
        frameHash,
        offset,
        scanId: parent?.scanId ?? token,
        lookupKey: key,
        expiresAt: parent?.expiresAt ?? Date.now() + 15 * 60_000,
      }),
    );
    this.reverse.set(key, token);
    return token;
  }

  clear(): void {
    this.entries.clear();
    this.reverse.clear();
  }

  private remove(token: string): void {
    const entry = this.entries.get(token)!;
    this.entries.delete(token);
    this.reverse.delete(entry.lookupKey);
  }
}
