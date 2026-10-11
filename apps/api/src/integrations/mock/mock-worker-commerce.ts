/** Pure, read-only connector composition for an independently authorized sync process. */
export { MockConnectorFactory } from "./mock-connector-factory.js";
export type {
  MockConnectorAccessResolver,
  MockFailureRuleLoader,
} from "./mock-connector-factory.js";
export { PersistentMockClock } from "./persistent-mock-clock.js";
export { MockConnectorError } from "./mock-call.js";
export type { BusinessClock, BusinessTime } from "./business-clock.js";
export type {
  PersistentReadBinder,
  PersistentReadPort,
  PersistentScope,
} from "./persistent-read-port.js";
