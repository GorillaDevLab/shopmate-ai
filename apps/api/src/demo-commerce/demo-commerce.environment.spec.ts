import { describe, expect, it } from "vitest";
import { readDemoCommerceEnvironment } from "./demo-commerce.environment.js";

const enabledEnv = {
  APP_ENV: "demo",
  ENABLE_DEMO_MODE: "true",
  APP_ORIGIN: "https://demo.example.com",
};

describe("demo commerce environment", () => {
  it.each(["development", "production", "test"])(
    "allows an explicitly enabled demo with NODE_ENV %s",
    (NODE_ENV) => {
      const value = readDemoCommerceEnvironment({ ...enabledEnv, NODE_ENV });
      expect(value).toEqual({ enabled: true, origin: enabledEnv.APP_ORIGIN });
      expect(Object.isFrozen(value)).toBe(true);
    },
  );

  it.each([
    {},
    { ...enabledEnv, APP_ENV: "production" },
    { ...enabledEnv, APP_ENV: "Demo" },
    { ...enabledEnv, APP_ENV: "demo " },
    { ...enabledEnv, ENABLE_DEMO_MODE: undefined },
    { ...enabledEnv, ENABLE_DEMO_MODE: "TRUE" },
    { ...enabledEnv, ENABLE_DEMO_MODE: "true " },
    { ...enabledEnv, APP_ORIGIN: undefined },
  ])("fails closed with missing or nonexact configuration %o", (env) => {
    expect(readDemoCommerceEnvironment(env)).toEqual({ enabled: false, origin: null });
  });

  it.each([
    "",
    "malformed",
    "file:///demo",
    "ftp://demo.example.com",
    "//demo.example.com",
    "https://demo.example.com/path",
    "https://demo.example.com/path/..",
    "https://demo.example.com/?",
    "https://demo.example.com/#",
    "https://demo.example.com/?q=secret",
    "https://user:secret@demo.example.com",
    "https://user@demo.example.com",
    "https://@demo.example.com",
    " https://demo.example.com",
    "https://demo.example.com ",
    "https:\\demo.example.com",
  ])("rejects non-origin configuration %s without echoing it", (APP_ORIGIN) => {
    const value = readDemoCommerceEnvironment({ ...enabledEnv, APP_ORIGIN });
    expect(value).toEqual({ enabled: false, origin: null });
    expect(Object.isFrozen(value)).toBe(true);
  });

  it.each([
    ["HTTPS://DEMO.EXAMPLE.COM:443/", "https://demo.example.com"],
    ["http://127.0.0.1:3000/", "http://127.0.0.1:3000"],
    ["https://[::1]:8443/", "https://[::1]:8443"],
  ])("normalizes explicit origin %s", (APP_ORIGIN, origin) => {
    expect(readDemoCommerceEnvironment({ ...enabledEnv, APP_ORIGIN })).toEqual({
      enabled: true,
      origin,
    });
  });
});
