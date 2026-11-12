import { expect, it } from "vitest";
import { eventRuntimeEnvironment } from "./event-runtime.environment.js";

it("requires a separate explicit PostgreSQL capability without a membership fallback", () => {
  expect(eventRuntimeEnvironment({ DATABASE_URL: "postgresql://admin@localhost/app" })).toBeNull();
  expect(
    eventRuntimeEnvironment({ EVENT_DECISION_DATABASE_URL: "postgresql://runtime@localhost/app" }),
  ).toEqual({ databaseUrl: "postgresql://runtime@localhost/app" });
});
it.each([
  "postgresql://postgres@localhost/app",
  "postgresql://root@localhost/app",
  "https://runtime@localhost/app",
  "postgresql://runtime@localhost/app?options=-csuperuser=on",
  "postgresql://runtime@localhost/app#fragment",
  "invalid",
])("disables malformed capability %s", (url) => {
  expect(eventRuntimeEnvironment({ EVENT_DECISION_DATABASE_URL: url })).toBeNull();
});
