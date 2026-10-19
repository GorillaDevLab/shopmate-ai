import { SourceVersionSchema, type MetricCalculator, type MetricResult } from "@shopmate/contracts";
import { z } from "zod";

export interface MetricDefinition {
  readonly definitionVersion: string;
  readonly calculator: MetricCalculator;
}
export interface MetricDefinitionRegistry {
  readonly resolve: (definitionVersion: string) => MetricResult<MetricDefinition>;
}

const definitionSchema = z.strictObject({
  definitionVersion: SourceVersionSchema,
  calculator: z.object({
    calculate: z.custom<MetricCalculator["calculate"]>((value) => typeof value === "function"),
  }),
});

function snapshot(definition: MetricDefinition): MetricDefinition {
  const calculate = definition.calculator.calculate;
  return Object.freeze({
    definitionVersion: definition.definitionVersion,
    calculator: Object.freeze({
      calculate: (request) => calculate(request),
    } satisfies MetricCalculator),
  });
}
function failure(code: "INVALID_INPUT" | "VERSION_MISMATCH"): MetricResult<MetricDefinition> {
  return Object.freeze({
    ok: false,
    error: Object.freeze({ code, evidenceIds: Object.freeze([]) }),
  });
}
function resolve(
  entries: ReadonlyMap<string, MetricDefinition>,
  version: string,
): MetricResult<MetricDefinition> {
  const parsed = SourceVersionSchema.safeParse(version);
  if (!parsed.success) return failure("INVALID_INPUT");
  const definition = entries.get(parsed.data);
  return definition ? Object.freeze({ ok: true, value: definition }) : failure("VERSION_MISMATCH");
}

/** Server construction configuration; exact definitions never register through request input. */
export function createMetricDefinitionRegistry(
  definitions: readonly MetricDefinition[],
): MetricDefinitionRegistry {
  const parsed = z.array(definitionSchema).safeParse(definitions);
  if (!parsed.success) throw new TypeError("Invalid metric definition configuration");
  const entries = new Map<string, MetricDefinition>();
  for (const definition of parsed.data) {
    if (entries.has(definition.definitionVersion))
      throw new TypeError("Duplicate metric definition version");
    entries.set(definition.definitionVersion, snapshot(definition));
  }
  return Object.freeze({ resolve: (version: string) => resolve(entries, version) });
}
