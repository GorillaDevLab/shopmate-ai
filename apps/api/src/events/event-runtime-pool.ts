import { createEventDecisionPool } from "@shopmate/database";

export const EVENT_RUNTIME_POOL_FACTORY = Symbol("EVENT_RUNTIME_POOL_FACTORY");
export type EventRuntimePoolFactory = typeof createEventDecisionPool;
