import { z } from "zod";

import { DashboardLayoutSchema } from "./dashboard-layout.schema.js";

const POSTGRESQL_INT_MAX = 2_147_483_647;

export const DashboardLayoutSaveRequestSchema = z.strictObject({
  layout: DashboardLayoutSchema,
  expectedRevision: z
    .number()
    .int()
    .min(0)
    .max(POSTGRESQL_INT_MAX - 1),
});
export type DashboardLayoutSaveRequest = z.infer<typeof DashboardLayoutSaveRequestSchema>;

const defaultLayoutResponseSchema = z.strictObject({
  layout: DashboardLayoutSchema,
  revision: z.literal(0),
  updatedAt: z.null(),
});

const persistedLayoutResponseSchema = z.strictObject({
  layout: DashboardLayoutSchema,
  revision: z.number().int().min(1).max(POSTGRESQL_INT_MAX),
  updatedAt: z.iso.datetime({ offset: true }),
});

export const DashboardLayoutReadResponseSchema = z.union([
  defaultLayoutResponseSchema,
  persistedLayoutResponseSchema,
]);
export type DashboardLayoutReadResponse = z.infer<typeof DashboardLayoutReadResponseSchema>;
