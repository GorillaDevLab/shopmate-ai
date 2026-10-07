import type {
  ClaimResult,
  AppendResult,
  ChunkInput,
  FailResult,
  LeaseRef,
  RenewResult,
  SourceFailureCode,
  PublishInput,
  PublishResult,
  Publication,
} from "./publication-types.js";
import type { SourceScanInput, SourceScanPage } from "./scan-types.js";

export interface SourceScope {
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly storeId: string;
  readonly sessionId: string;
  readonly connectionId: string;
  readonly externalStoreId: string;
  readonly generation: number;
}
export interface SourceReadActor {
  readonly userId: string;
  readonly merchantId: string;
}
export interface SourceWorkerActor {
  readonly grantId: string;
}
export interface SourceWorkerGrant extends Omit<SourceScope, "generation"> {
  readonly id: string;
  readonly databaseRole: string;
  readonly principalUserId: string;
  readonly operation: "SOURCE_BUILD";
  readonly status: "ACTIVE";
}
export interface SourceGeneration {
  readonly scope: SourceScope;
  readonly sourceConfig: unknown;
  readonly configHash: string;
  readonly generatorVersion: string;
  readonly runtimeVersion: "mock-runtime-v2";
  readonly openingAt: string;
  readonly baselineEnd: string;
  readonly createdAt: string;
}
export type SourceInitialization =
  | { readonly status: "CREATED" | "EXISTS"; readonly generation: SourceGeneration }
  | { readonly status: "DENIED" };
/** Total read lifetime defaults to 30s and caps longer deadlines at 30s. */
export interface SourceReadControl {
  readonly signal?: AbortSignal;
  /** Canonical UTC timestamp, including milliseconds and Z. */
  readonly deadlineAt?: string;
}
export interface MockSourceReader {
  findPublication(
    actor: SourceReadActor,
    scope: SourceScope,
    control?: SourceReadControl,
  ): Promise<Publication | null>;
  findGeneration(
    actor: SourceReadActor,
    scope: SourceScope,
    control?: SourceReadControl,
  ): Promise<SourceGeneration | null>;
  scanVersions(
    actor: SourceReadActor,
    scope: SourceScope,
    input: SourceScanInput,
    control?: SourceReadControl,
  ): Promise<SourceScanPage | null>;
  close(): Promise<void>;
}
export interface MockSourceWorker {
  listGrants(): Promise<readonly SourceWorkerGrant[]>;
  initializeGeneration(actor: SourceWorkerActor, scope: SourceScope): Promise<SourceInitialization>;
  claim(actor: SourceWorkerActor, scope: SourceScope): Promise<ClaimResult>;
  renew(actor: SourceWorkerActor, lease: LeaseRef): Promise<RenewResult>;
  fail(actor: SourceWorkerActor, lease: LeaseRef, code: SourceFailureCode): Promise<FailResult>;
  appendChunk(actor: SourceWorkerActor, lease: LeaseRef, input: ChunkInput): Promise<AppendResult>;
  publish(actor: SourceWorkerActor, lease: LeaseRef, input: PublishInput): Promise<PublishResult>;
  close(): Promise<void>;
}
export type SourceEnvironment = Readonly<Record<string, string | undefined>>;
