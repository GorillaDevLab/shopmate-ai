import { describe, expect, it, vi } from "vitest";
import { DemoFailureRulesService } from "./demo-failure-rules.service.js";
import { actor, access, repository } from "../../test/helpers/demo-commerce.fixture.js";

const rule = {
  id: "rule-a",
  priority: 1,
  startsAt: "2026-01-01T00:00:00.000Z",
  endsAt: "2026-01-02T00:00:00.000Z",
  methods: ["getStore"],
  effect: { kind: "FAIL", code: "TEMPORARY", retryAfterMs: null },
};
const view = {
  sessionId: "session-a",
  generation: 0,
  revision: 1,
  clockNow: rule.startsAt,
  rules: [],
};
function setup(enabled = true) {
  const session = repository();
  const rules = {
    findDemoFailureRules: vi.fn().mockResolvedValue(view),
    createDemoFailureRule: vi.fn().mockResolvedValue({ status: "WRITTEN", view }),
    removeDemoFailureRule: vi.fn().mockResolvedValue({ status: "WRITTEN", view }),
  };
  return {
    session,
    rules,
    service: new DemoFailureRulesService(session, rules, {
      enabled,
      origin: enabled ? "https://demo.example.com" : null,
    }),
  };
}
describe("authenticated demo failure controls", () => {
  it("denies production before database access", async () => {
    const { rules, service } = setup(false);
    await expect(service.get(actor, "store-a")).rejects.toMatchObject({ status: 404 });
    expect(rules.findDemoFailureRules).not.toHaveBeenCalled();
  });
  it("uses current role and passes only trusted actor to mutation", async () => {
    const { session, rules, service } = setup();
    vi.mocked(session.findDemoStore).mockResolvedValue({ ...access, role: "VIEWER" });
    await expect(
      service.create(actor, "store-a", { expectedRevision: 0, rule }),
    ).rejects.toMatchObject({ status: 403 });
    expect(rules.createDemoFailureRule).not.toHaveBeenCalled();
    vi.mocked(session.findDemoStore).mockResolvedValue(access);
    await service.create(actor, "store-a", { expectedRevision: 0, rule });
    expect(rules.createDemoFailureRule).toHaveBeenCalledWith(actor, "store-a", {
      expectedRevision: 0,
      rule,
    });
  });
  it("rejects malformed and unconfirmed removal and sanitizes storage errors", async () => {
    const { rules, service } = setup();
    await expect(
      service.remove(actor, "store-a", { expectedRevision: 1, ruleId: "rule-a" }),
    ).rejects.toMatchObject({ status: 400 });
    rules.createDemoFailureRule.mockResolvedValue({ status: "CONFLICT" });
    await expect(
      service.create(actor, "store-a", { expectedRevision: 0, rule }),
    ).rejects.toMatchObject({ status: 409 });
    rules.findDemoFailureRules.mockRejectedValue(new Error("postgres://secret@host"));
    await expect(service.get(actor, "store-a")).rejects.toMatchObject({
      status: 503,
      response: { message: "演示操作无法完成" },
    });
  });
});
