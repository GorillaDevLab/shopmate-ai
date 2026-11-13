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
