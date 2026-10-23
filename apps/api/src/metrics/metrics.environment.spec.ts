import { expect, it } from "vitest";
import { metricEnvironment } from "./metrics.environment.js";

it("requires explicit metric credentials and a stable UTF-8 key", () => {
  expect(metricEnvironment({ DATABASE_URL: "postgresql://owner@localhost/app" })).toBeNull();
  expect(
    metricEnvironment({
      METRIC_DATABASE_URL: "postgresql://reader@localhost/app",
      METRIC_CURSOR_SECRET: "short",
    }),
  ).toBeNull();
});
it("rejects URL options and owner defaults without exposing configuration", () => {
  expect(
    metricEnvironment({
      METRIC_DATABASE_URL: "postgresql://postgres@localhost/app",
      METRIC_CURSOR_SECRET: "x".repeat(32),
    }),
  ).toBeNull();
  expect(
    metricEnvironment({
      METRIC_DATABASE_URL: "postgresql://reader@localhost/app?options=-crole=owner",
      METRIC_CURSOR_SECRET: "x".repeat(32),
    }),
  ).toBeNull();
});
it("copies the supplied stable key and keeps provisioning separate", () => {
  const result = metricEnvironment({
    METRIC_DATABASE_URL: "postgresql://reader@localhost/app",
    METRIC_CURSOR_SECRET: "界".repeat(11),
  });
  expect(result?.cursorSecret.toString()).toBe("界".repeat(11));
  expect(result?.definitionUrl).toBeNull();
});
it("provisions only the same server and database with a separate login", () => {
  const env = {
    METRIC_DATABASE_URL: "postgresql://reader@localhost/app",
    METRIC_CURSOR_SECRET: "x".repeat(32),
  };
  expect(
    metricEnvironment({
      ...env,
      METRIC_DEFINITION_DATABASE_URL: "postgresql://writer@localhost:5432/app",
    }),
  ).not.toBeNull();
  for (const target of [
    "postgresql://writer@other/app",
    "postgresql://writer@localhost/other",
    "postgresql://writer@localhost:5433/app",
    "postgresql://reader@localhost/app",
  ])
    expect(metricEnvironment({ ...env, METRIC_DEFINITION_DATABASE_URL: target })).toBeNull();
});
