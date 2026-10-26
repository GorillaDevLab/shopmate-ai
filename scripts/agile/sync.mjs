import { readFile, writeFile, mkdir, appendFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { URL } from "node:url";
import { fileURLToPath } from "node:url";
import { createGitHub } from "./github.mjs";
import { reconcile } from "./reconcile.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const backlogPath = new URL(
  "../../docs/superpowers/plans/p3-p13-agile/backlog.json",
  import.meta.url,
);
const configPath = new URL("./config.json", import.meta.url);

export function parseArgs(argv) {
  const options = {
    apply: false,
    labelsOnly: false,
    report: resolve(root, ".superpowers/sdd/agile-sync-last-plan.json"),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") options.apply = true;
    else if (arg === "--labels-only") options.labelsOnly = true;
    else if (
      arg === "--report" &&
      argv[index + 1] &&
      !argv[index + 1].startsWith("--") &&
      !argv[index + 1].includes("\0") &&
      argv[index + 1].length < 400
    )
      options.report = resolve(argv[++index]);
    else if (arg === "--help") options.help = true;
    else throw new Error(`unknown or invalid CLI argument ${arg.slice(0, 40)}`);
  }
  return options;
}

function validateConfig(config) {
  if (
    typeof config.owner !== "string" ||
    !/^[\w-]+$/.test(config.owner) ||
    typeof config.repo !== "string" ||
    !/^[\w.-]+$/.test(config.repo) ||
    typeof config.org !== "string" ||
    !/^[\w-]+$/.test(config.org) ||
    !Number.isSafeInteger(config.projectNumber) ||
    typeof config.defaultBranch !== "string" ||
    !/^[\w./-]+$/.test(config.defaultBranch) ||
    config.requiredChecks?.length !== 6 ||
    new Set(config.requiredChecks).size !== 6
  )
    throw new Error("invalid agile configuration");
  return config;
}

async function persist(path, report) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
}

async function summary(result) {
  const changed = result.plan?.changed ?? [];
  const lines = [
    `### Agile task state: ${result.status}`,
    "",
    `Changed cards: ${changed.length}`,
    ...changed.map(
      (entry) =>
        `- ${entry.id}: ${entry.before} → ${entry.after}; Project ${entry.projectBefore} → ${entry.after}; ${entry.blockers.join(", ") || "no blockers"}`,
    ),
    "",
    "Project synchronization is required for full success.",
  ];
  if (process.env.GITHUB_STEP_SUMMARY)
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`);
  process.stdout.write(`Agile reconciliation ${result.status}; ${changed.length} changed cards.\n`);
}

// Several PRs merged within a minute race on the same cards. A "conflict" means the card
// changed after planning and nothing was written, so a fresh snapshot is safe to retry.
// Partial writes and data errors (e.g. ambiguous stages) still fail for a human to inspect.
const CONFLICT_RETRY_DELAYS_MS = [5_000, 15_000];

export async function reconcileWithConflictRetry({
  run,
  sleep = delay,
  delays = CONFLICT_RETRY_DELAYS_MS,
}) {
  let attempts = 1;
  let result = await run();
  while (result.status === "conflict" && attempts <= delays.length) {
    process.stdout.write(`Agile reconciliation conflict; retrying (attempt ${attempts + 1}).
`);
    await sleep(delays[attempts - 1]);
    attempts += 1;
    result = await run();
  }
  return { ...result, attempts };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(
      "Usage: node scripts/agile/sync.mjs [--apply] [--labels-only] [--report PATH]\n",
    );
    return;
  }
  const config = validateConfig(JSON.parse(await readFile(configPath, "utf8")));
  const cards = JSON.parse(await readFile(backlogPath, "utf8"));
  const api = createGitHub({
    ...config,
    repoToken: process.env.GH_TOKEN || process.env.GITHUB_TOKEN,
    projectToken: process.env.PROJECT_TOKEN,
  });
  const result = await reconcileWithConflictRetry({
    run: () =>
      reconcile({
        api,
        cards,
        config,
        apply: args.apply,
        labelsOnly: args.labelsOnly,
        persist: (report) => persist(args.report, report),
      }),
  });
  await summary(result);
  if (!["dry-run", "applied"].includes(result.status)) process.exitCode = 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`Agile reconciliation failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
