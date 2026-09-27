import { AGENT_ACTION_TTL_MS } from "@shopmate/contracts";
import { describe, expect, it } from "vitest";

import { AgentActionStore, type AgentActionPayload } from "./agent-action-store.js";

const owner = { userId: "u1", merchantId: "m1" };
const content = { title: "创建经营监听", summary: "销售额下降提醒", details: [] };
const payload: AgentActionPayload = {
  kind: "createMonitoringRule",
  rule: {
    name: "销售额下降提醒",
    definition: {
      kind: "salesThreshold",
      metric: "revenue",
      operator: "below",
      threshold: 1000,
      window: "7d",
      frequency: "daily",
    },
  },
};

describe("AgentActionStore", () => {
  it("issues a proposal that can be taken exactly once by the same actor", () => {
    const store = new AgentActionStore();
    const proposal = store.propose(owner, content, payload);
    expect(proposal).toMatchObject({ kind: "createMonitoringRule", title: "创建经营监听" });
    expect(store.take(proposal.token, owner)).toMatchObject({ kind: "ok" });
    expect(store.take(proposal.token, owner)).toEqual({ kind: "not_found" });
  });

  it("hides proposals from other users and merchants without consuming them", () => {
    const store = new AgentActionStore();
    const { token } = store.propose(owner, content, payload);
    expect(store.take(token, { userId: "u2", merchantId: "m1" })).toEqual({ kind: "not_found" });
    expect(store.take(token, { userId: "u1", merchantId: "m2" })).toEqual({ kind: "not_found" });
    expect(store.take(token, owner)).toMatchObject({ kind: "ok" });
  });

  it("expires proposals after the TTL", () => {
    let now = 1_000;
    const store = new AgentActionStore(() => now);
    const { token, expiresAt } = store.propose(owner, content, payload);
    expect(Date.parse(expiresAt)).toBe(1_000 + AGENT_ACTION_TTL_MS);
    now += AGENT_ACTION_TTL_MS;
    expect(store.take(token, owner)).toEqual({ kind: "expired" });
  });

  it("limits how many proposals one actor can keep pending", () => {
    const store = new AgentActionStore();
    for (let i = 0; i < 30; i += 1) store.propose(owner, content, payload);
    expect(() => store.propose(owner, content, payload)).toThrow("待确认的操作过多");
    expect(() => store.propose({ userId: "u2", merchantId: "m1" }, content, payload)).not.toThrow();
  });
});
