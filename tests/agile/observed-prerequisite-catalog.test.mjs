import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { URL } from "node:url";
import { validateGraph } from "../../scripts/agile/policy.mjs";

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const pool = "docs/superpowers/plans/p3-p13-agile/";
const cards = JSON.parse(read(`${pool}backlog.json`));
const approved = JSON.parse(
  read("docs/superpowers/specs/2026-11-11-observed-fact-prerequisite-cards.json"),
);
const ids = approved.cards.map((card) => card.id);
const additions = cards.filter((card) => ids.includes(card.id));
const consumers = ["P04-029", "P04-031", "P04-032"];
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fields =
  "id phase title hours lane kind priority contract consumes produces files sharedFiles dependsOn integrationDependsOn acceptance tests outOfScope risk parallelGroup note".split(
    " ",
  );
const arrayFields =
  "consumes produces files sharedFiles dependsOn integrationDependsOn acceptance tests outOfScope".split(
    " ",
  );
const section = (card) =>
  read(`${pool}phase-${String(card.phase).padStart(2, "0")}.md`)
    .split(`## ${card.id}：`)[1]
    ?.split(/\n<a id=/)[0];

// Hashes freeze reviewed data without copying the 228-card historical fixture into tests.
test("the real catalog contains the approved coherent 30-card DAG and capped totals", () => {
  assert.equal(cards.length, 258);
  assert.equal(additions.length, 30);
  assert.equal(
    cards.reduce((sum, card) => sum + card.hours, 0),
    848,
  );
  const graph = validateGraph(cards, { externalGateIds: ["P2-GATE"] });
  assert.equal(graph.size, 258);
  for (const [phase, count, hours] of [
    [3, 36, 129],
    [4, 44, 151],
  ]) {
    const phaseCards = cards.filter((card) => card.phase === phase);
    assert.equal(phaseCards.length, count);
    assert.equal(
      phaseCards.reduce((sum, card) => sum + card.hours, 0),
      hours,
    );
  }
  assert.equal(hash(additions), "9783ea3520871996cf72c26ad996a6403e4c35b7d0ac87e6a29925a5167687d2");
});

test("all cards use the canonical 20-field shape and legal planning values", () => {
  for (const card of cards) {
    assert.deepEqual(Object.keys(card).sort(), [...fields].sort(), card.id);
    assert.ok(Number.isInteger(card.phase) && card.phase >= 3 && card.phase <= 13);
    assert.ok(Number.isInteger(card.hours) && card.hours >= 1 && card.hours <= 4);
    assert.ok(
      ["contract", "database", "backend", "frontend", "integration", "qa", "research"].includes(
        card.lane,
      ),
    );
    assert.ok(
      ["contract", "component", "integration", "verification", "research"].includes(card.kind),
    );
    for (const field of arrayFields) {
      assert.ok(Array.isArray(card[field]), `${card.id}.${field}`);
      assert.ok(card[field].every((value) => typeof value === "string" && value.length > 0));
    }
    for (const field of fields.filter(
      (name) => !arrayFields.includes(name) && !["phase", "hours"].includes(name),
    )) {
      assert.equal(typeof card[field], "string", `${card.id}.${field}`);
    }
  }
});

test("the approved contracts, proof, exclusions and exact per-card locks survive mapping", () => {
  assert.deepEqual(
    additions.map((card) => card.id),
    ids,
  );
  for (const frozen of approved.cards) {
    const card = additions.find((entry) => entry.id === frozen.id);
    assert.equal(card.contract, frozen.contract);
    assert.equal(card.hours, frozen.capHours);
    assert.deepEqual(card.files, frozen.ownedFiles);
    assert.deepEqual(card.sharedFiles, frozen.sharedLocks);
    assert.deepEqual(card.dependsOn, frozen.hardDependencies);
    assert.deepEqual(card.integrationDependsOn, []);
    assert.deepEqual(card.outOfScope, frozen.outOfScope);
    for (const requirement of [...frozen.acceptance, ...approved.commonAcceptance]) {
      assert.ok(card.acceptance.includes(requirement), `${card.id}: ${requirement}`);
    }
    for (const proof of frozen.proof) assert.ok(card.produces.includes(proof), card.id);
    for (const lock of approved.commonSharedLocks) assert.ok(card.note.includes(lock), card.id);
    assert.match(card.note, /触及这些共享路径必须先取得锁/);
  }
});

const preservedConsumers = () =>
  Object.fromEntries(
    cards
      .filter((card) => consumers.includes(card.id))
      .map((card) => {
        const edits =
          card.id === "P04-029"
            ? ["note", "sharedFiles", "files"]
            : ["dependsOn", "consumes", "acceptance"];
        return [
          card.id,
          Object.fromEntries(Object.entries(card).filter(([key]) => !edits.includes(key))),
        ];
      }),
  );

test("old cards retain all data outside the three explicitly coordinated consumer edits", () => {
  const untouched = cards.filter((card) => !ids.includes(card.id) && !consumers.includes(card.id));
  assert.equal(untouched.length, 225);
  assert.equal(hash(untouched), "a4f7224477a24429743e96980202108313f4604a8320a4c064471b8495cb3d46");
  const preserved = preservedConsumers();
  assert.equal(hash(preserved), "8b16b1f05fc9ae8037d1433d2bc2097869e32f089e8c175aabee66b471d55e52");
});

test("consumer full-family hard gates preserve separate bounded 029 and contention 030", () => {
  assert.deepEqual(cards.find((card) => card.id === "P04-031").dependsOn, [
    "P2-GATE",
    "P03-018",
    "P04-029",
    "P04-033",
    "P04-044",
  ]);
  assert.deepEqual(cards.find((card) => card.id === "P04-032").dependsOn, [
    "P2-GATE",
    "P04-029",
    "P04-030",
    "P04-031",
    "P04-044",
  ]);
});

const bullets = (text, heading) =>
  text
    .split(`**${heading}：**`)[1]
    ?.split(/\n\*\*/)[0]
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => line.replaceAll("\\*", "*"));

function assertDocumentFields(card, text) {
  for (const [field, heading] of [
    ["consumes", "输入"],
    ["produces", "输出"],
    ["acceptance", "验收"],
    ["tests", "测试"],
    ["outOfScope", "不包含"],
  ]) {
    const prefix = field === "acceptance" ? "- [ ] " : "- ";
    assert.deepEqual(
      bullets(text, heading),
      card[field].map((value) => prefix + value),
      `${card.id}.${field}`,
    );
  }
  for (const [field, heading] of [
    ["files", "独占文件（新路径为计划创建）"],
    ["sharedFiles", "共享文件锁（协调集成修改）"],
  ]) {
    assert.deepEqual(
      bullets(text, heading),
      card[field].length ? card[field].map((value) => `- \`${value}\``) : ["- 无"],
      `${card.id}.${field}`,
    );
  }
}

test("phase documentation retains every approved field and exact shared-file lists", () => {
  for (const card of cards.filter(
    (entry) => ids.includes(entry.id) || consumers.includes(entry.id),
  )) {
    const text = section(card);
    assert.ok(text, card.id);
    assert.ok(text.includes(`**契约：** ${card.contract}`), card.id);
    assertDocumentFields(card, text);
    assert.ok(text.includes(`**硬依赖：** ${card.dependsOn.join(", ") || "无"}`));
    assert.ok(text.includes(`**实际接线依赖：** ${card.integrationDependsOn.join(", ") || "无"}`));
    assert.ok(text.includes(`**执行边界：** ${card.note}`));
  }
});

test("the complete README index and documented counts match the catalog", () => {
  const index = read(`${pool}README.md`);
  const rows = index.split("\n").filter((line) => /^\| \[P\d{2}-\d{3}\]/.test(line));
  assert.equal(rows.length, cards.length);
  for (const card of cards) {
    const row = rows.find((line) => line.startsWith(`| [${card.id}]`));
    assert.ok(row, card.id);
    const cells = row
      .split("|")
      .slice(1, -1)
      .map((value) => value.trim());
    assert.equal(cells[1], card.title);
    assert.equal(cells[2], `${card.hours}h`);
    assert.equal(cells[3], card.dependsOn.join(", ") || "无");
  }
  assert.match(index, /258.*848/);
  assert.match(index, /初始 Ready 仅表示无硬依赖/);
  assert.match(read("docs/engineering/agile-state-sync.md"), /258/);
  assert.match(read("docs/superpowers/plans/2026-10-04-p3-p13-agile-task-pool.md"), /258.*848/);
});

// Freeze the coordinated consumer footprint and approved requirement text independently.
test("consumer amendments retain exact original acceptance plus approved scope and locks", () => {
  assert.equal(
    hash(cards.filter((card) => consumers.includes(card.id))),
    "25661488c59c9920a7398ce2fa4cdb83a95b32b708233f90f1d3d679483e409b",
  );
  assert.equal(
    hash([approved.cards, approved.commonAcceptance, approved.commonSharedLocks]),
    "74c9fc08c6f32a126735cca94013f3208fcfea2a1abd405f291ad8aeee44d973",
  );
});
