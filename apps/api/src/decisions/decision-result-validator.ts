import {
  DecisionControlSchema,
  DecisionProviderDescriptorSchema,
  DecisionResultSchema,
  EvaluationContextSchema,
  SourceVersionSchema,
  type DecisionControl,
  type DecisionPortError,
  type DecisionPortResult,
  type DecisionProviderDescriptor,
  type DecisionResult,
  type DecisionUnavailableCode,
  type EvaluationContext,
  type HostEvidenceHash,
} from "@shopmate/contracts";
import { z } from "zod";
import { CanonicalHostEvidenceHash } from "./decision-input-sanitizer.js";

export interface DecisionResultValidatorOptions {
  readonly descriptor: DecisionProviderDescriptor;
  readonly supportedInputVersions: readonly number[];
  readonly rulesetVersion: string;
  readonly hasher?: HostEvidenceHash;
}
/** Opaque in-process host handle; never include this object in a provider payload. */
export interface PreparedDecisionValidation {
  readonly status: "PREPARED";
}
export type DecisionValidationPreparation =
  | PreparedDecisionValidation
  | Extract<DecisionResult, { status: "UNAVAILABLE" }>;

const configurationSchema = z
  .strictObject({
    descriptor: DecisionProviderDescriptorSchema,
    supportedInputVersions: z
      .array(z.number().int().positive().max(Number.MAX_SAFE_INTEGER))
      .max(64)
      .readonly(),
    rulesetVersion: SourceVersionSchema,
  })
  .readonly();
type VerifiedContext = Readonly<{ context: EvaluationContext; hash: string; key: string }>;
type HostBinding = Readonly<{
  contextKey: string;
  hash: string;
  correlationId: string;
  control: DecisionControl;
}>;

function failure<T>(code: DecisionPortError): DecisionPortResult<T> {
  return Object.freeze({ ok: false, code });
}

function success<T>(value: T): DecisionPortResult<T> {
  return Object.freeze({ ok: true, value });
}

function unavailable(correlationId: string, code: DecisionUnavailableCode) {
  return Object.freeze({ schemaVersion: 1, status: "UNAVAILABLE", correlationId, code } as const);
}

function contextKey(context: EvaluationContext): string {
  return JSON.stringify({
    schemaVersion: context.schemaVersion,
    actor: context.actor,
    requestId: context.requestId,
    correlationId: context.correlationId,
    event: {
      ...context.event,
      firstSeenAt: new Date(context.event.firstSeenAt).toISOString(),
      lastSeenAt: new Date(context.event.lastSeenAt).toISOString(),
    },
    reference: context.evidence.reference,
  });
}

function verifyContext(
  context: unknown,
  hasher: HostEvidenceHash,
): DecisionPortResult<VerifiedContext> {
  const parsed = EvaluationContextSchema.safeParse(context);
  if (!parsed.success) return failure("INVALID_INPUT");
  const hash = hasher.hash(parsed.data.evidence.evidence);
  if (!hash.ok) return hash;
  if (hash.value !== parsed.data.evidence.reference.hash) return failure("HASH_MISMATCH");
  return success(
    Object.freeze({ context: parsed.data, hash: hash.value, key: contextKey(parsed.data) }),
  );
}

/** Host-only metadata continuity; this does not claim the provider echoed scope or a digest. */
export class DecisionResultValidator {
  readonly #configuration: z.infer<typeof configurationSchema>;
  readonly #hasher: HostEvidenceHash;
  readonly #bindings = new WeakMap<PreparedDecisionValidation, HostBinding>();

  constructor(options: DecisionResultValidatorOptions) {
    const { hasher, ...configuration } = options;
    this.#configuration = configurationSchema.parse(configuration);
    this.#hasher = hasher ?? new CanonicalHostEvidenceHash();
  }

  /** Preflight before provider invocation; real deadline/abort orchestration belongs to the host. */
  prepare(
    context: unknown,
    control: DecisionControl,
  ): DecisionPortResult<DecisionValidationPreparation> {
    try {
      const parsedControl = DecisionControlSchema.safeParse(control);
      if (!parsedControl.success) return failure("INVALID_INPUT");
      const verified = verifyContext(context, this.#hasher);
      if (!verified.ok) return verified;
      const version = verified.value.context.schemaVersion;
      if (
        !this.#configuration.supportedInputVersions.includes(version) ||
        !this.#configuration.descriptor.supportedInputVersions.includes(version)
      )
        return success(unavailable(verified.value.context.correlationId, "UNSUPPORTED_SCHEMA"));
      const prepared = Object.freeze({ status: "PREPARED" } as const);
      this.#bindings.set(
        prepared,
        Object.freeze({
          contextKey: verified.value.key,
          hash: verified.value.hash,
          correlationId: verified.value.context.correlationId,
          // Parsing freezes plain metadata only; the native signal retains identity and remains live.
          control: parsedControl.data,
        }),
      );
      return success(prepared);
    } catch {
      return failure("INVALID_INPUT");
    }
  }

  /** Current context, descriptor and control must come from the trusted host, never model output. */
  validate(
    raw: unknown,
    prepared: PreparedDecisionValidation,
    currentContext: unknown,
    currentDescriptor: DecisionProviderDescriptor,
    currentControl: DecisionControl,
  ): DecisionPortResult<DecisionResult> {
    const binding = this.#bindings.get(prepared);
    if (!binding) return failure("INVALID_INPUT");
    const invalid = unavailable(binding.correlationId, "INVALID_RESULT");
    try {
      if (!this.matchesHost(binding, currentContext, currentDescriptor, currentControl))
        return success(invalid);
      const parsed = DecisionResultSchema.safeParse(raw);
      if (!parsed.success || parsed.data.correlationId !== binding.correlationId)
        return success(invalid);
      if (
        parsed.data.status === "EVALUATED" &&
        parsed.data.rulesetVersion !== this.#configuration.rulesetVersion
      )
        return success(invalid);
      return success(parsed.data);
    } catch {
      // Treat hostile output or thrown nested contract checks as unavailable, never evaluated.
      return success(invalid);
    }
  }

  private matchesHost(
    binding: HostBinding,
    context: unknown,
    descriptor: DecisionProviderDescriptor,
    control: DecisionControl,
  ): boolean {
    const current = verifyContext(context, this.#hasher);
    const parsedDescriptor = DecisionProviderDescriptorSchema.safeParse(descriptor);
    const parsedControl = DecisionControlSchema.safeParse(control);
    return (
      current.ok &&
      current.value.hash === binding.hash &&
      current.value.key === binding.contextKey &&
      parsedDescriptor.success &&
      JSON.stringify(parsedDescriptor.data) === JSON.stringify(this.#configuration.descriptor) &&
      parsedControl.success &&
      parsedControl.data.signal === binding.control.signal &&
      Date.parse(parsedControl.data.deadlineAt) === Date.parse(binding.control.deadlineAt)
    );
  }
}
