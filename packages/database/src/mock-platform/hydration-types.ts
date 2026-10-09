import type { Checkpoint } from "./publication-types.js";
import type { SourceVersion } from "./scan-types.js";

export type HydrationKind = "ORDER" | "INVENTORY" | "MARKETING";
export type HydrationEntityKey =
  | readonly ["ORDER", string]
  | readonly ["INVENTORY", string, string]
  | readonly ["MARKETING", string, string];
export interface BuildHydrationInput {
  readonly expectedCheckpointHash: string;
  readonly beforeTime: string;
  readonly kind: HydrationKind;
  readonly entityKeys: readonly HydrationEntityKey[];
}
export type BuildHydrationResult =
  | {
      readonly status: "HYDRATED";
      readonly checkpoint: Checkpoint;
      readonly checkpointHash: string;
      readonly items: readonly SourceVersion[];
    }
  | { readonly status: "DENIED" | "FENCED" | "CONFLICT" };
