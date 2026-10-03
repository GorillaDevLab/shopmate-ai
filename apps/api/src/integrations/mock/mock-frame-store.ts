import { ConnectorTimestampSchema } from "@shopmate/contracts";
import type { BusinessClock } from "./business-clock.js";
import { MockConnectorError } from "./mock-call.js";
import { MockConfigSchema, type MockConfig } from "./mock-config.js";
import { generateMockSource } from "./mock-source.js";
import type { MockSnapshot } from "./mock-types.js";

export function canonicalMockTime(input: unknown): string {
  const parsed = ConnectorTimestampSchema.safeParse(input);
  if (!parsed.success) throw new MockConnectorError("INVALID_INPUT");
  const normalized = ConnectorTimestampSchema.safeParse(new Date(parsed.data).toISOString());
  if (!normalized.success) throw new MockConnectorError("INVALID_INPUT");
  return normalized.data;
}

export class MockFrameStore {
  readonly config: MockConfig;
  private readonly frames = new Map<string, MockSnapshot>();

  constructor(
    input: unknown,
    private readonly clock: BusinessClock,
  ) {
    this.config = MockConfigSchema.parse(input);
  }

  current(): string {
    return canonicalMockTime(this.clock.snapshot().now);
  }

  at(until: string): MockSnapshot {
    const at = new Date(
      Math.min(Date.parse(canonicalMockTime(until)), Date.parse(this.current())),
    ).toISOString();
    const existing = this.frames.get(at);
    if (existing) return existing;
    const frame = generateMockSource(this.config, at);
    if (this.frames.size >= 2) this.frames.delete(this.frames.keys().next().value!);
    this.frames.set(at, frame);
    return frame;
  }

  pinned(hash: string): MockSnapshot {
    const frame = [...this.frames.values()].find((item) => item.datasetHash === hash);
    if (!frame) throw new MockConnectorError("CONFLICT");
    return frame;
  }

  clear(): void {
    this.frames.clear();
  }
}
