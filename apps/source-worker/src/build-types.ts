import type {
  HydrationEntityKey,
  SnapshotEvent,
  Publication,
} from "@shopmate/database/mock-platform";

export type HydratedRows = Readonly<
  Record<"ORDER" | "INVENTORY" | "MARKETING", readonly unknown[]>
>;
export interface GenerationTools {
  hydrationKeys(config: unknown, beforeTime: string): readonly HydrationEntityKey[];
  create(
    config: unknown,
    rows: HydratedRows,
    beforeTime: string,
  ): {
    window(
      after: string,
      until: string,
    ): Iterable<{
      readonly occurredAt: string;
      readonly events: readonly SnapshotEvent[];
    }>;
  };
}
export type BuildOutcome =
  | { readonly status: "PUBLISHED"; readonly publication: Publication }
  | { readonly status: "IDLE" | "BUSY" | "DENIED" | "UNINITIALIZED" | "FENCED" | "CONFLICT" };
export class BuildInterrupted extends Error {
  constructor() {
    super("SOURCE_BUILD_INTERRUPTED");
  }
}
export class BuildHalted extends Error {
  constructor(readonly status: "DENIED" | "FENCED" | "CONFLICT") {
    super(status);
  }
}
