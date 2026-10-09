import assert from "node:assert/strict";
import test from "node:test";
import { ReadControl } from "../dist/src/mock-platform/read-control.js";

for (const input of [{}, { deadlineAt: "2099-01-01T00:00:00.000Z" }]) {
  test(`read lifetime is bounded to thirty seconds: ${JSON.stringify(input)}`, (t) => {
    t.mock.timers.enable({
      apis: ["Date", "setTimeout"],
      now: Date.parse("2026-01-01T00:00:00.000Z"),
    });
    const control = new ReadControl(input);
    let canceled = 0;
    control.bind(() => {
      canceled++;
    });
    t.mock.timers.tick(29_999);
    control.check();
    t.mock.timers.tick(1);
    assert.equal(canceled, 1);
    assert.throws(() => control.check(), { code: "SOURCE_DEADLINE" });
    control.close();
  });
}
