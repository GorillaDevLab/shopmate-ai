import { z } from "zod";
import { TenantIdSchema } from "../tenant/tenant.schema.js";
import { ConnectorTimestampSchema } from "../commerce/connector-common.schema.js";
import { MockScenarioIdSchema, MockScenarioPlanSchema } from "../commerce/mock-scenario.schema.js";
const counter = z.number().int().min(0).max(2147483647);
const clock = ConnectorTimestampSchema.transform((value) => new Date(value).toISOString())
  .pipe(ConnectorTimestampSchema)
  .refine((value) => !value.startsWith("0000-"));
export const DemoScenarioLoadSchema = z
  .strictObject({
    scenarioId: MockScenarioIdSchema,
    confirmSessionId: TenantIdSchema,
    expectedRevision: counter.max(2147483646),
    expectedGeneration: counter.max(2147483646),
    observedAt: clock,
    startDay: z.number().int().min(0).max(364).optional(),
    endDay: z.number().int().min(1).max(365).optional(),
  })
  .refine(
    (value) =>
      value.startDay === undefined || value.endDay === undefined || value.startDay < value.endDay,
  )
  .readonly();
export const DemoScenarioRunSchema = z
  .strictObject({
    id: TenantIdSchema,
    generation: counter,
    loadedRevision: counter,
    configHash: z.string().regex(/^[a-f0-9]{64}$/u),
    loadedAt: clock,
    status: z.enum(["ACTIVE", "SUPERSEDED", "DISCONNECTED"]),
    plan: MockScenarioPlanSchema,
  })
  .readonly();
export const DemoScenarioViewSchema = z
  .strictObject({
    sessionId: TenantIdSchema,
    generation: counter,
    revision: counter,
    clockNow: clock,
    runs: z.array(DemoScenarioRunSchema).max(20),
  })
  .readonly();
export type DemoScenarioLoad = z.infer<typeof DemoScenarioLoadSchema>;
export type DemoScenarioView = z.infer<typeof DemoScenarioViewSchema>;
