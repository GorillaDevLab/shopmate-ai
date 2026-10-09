# Canonical order storage delivery

Worktree: `C:/Users/harry/.codex/worktrees/p25-sync-host/aiShopASAS`
Branch: `feat/canonical-order-storage`

## Delivered

Migration `20261009010000_canonical_orders` adds typed order/line storage, scoped composite foreign keys, economic/status/time/quality constraints, deferred complete-snapshot checks, and forced reader RLS. Prisma models retain the product commit relation from main. No order RPC, worker DML, SDK, completion, deployment or P3 work is included.

Independent commits:

- `131e99a` — schema/migration and real PostgreSQL tests.
- `8c69a49` — ordinary merge of current main (`dfa056d`), resolving the SourceScope conflict by preserving both order and product commit relations.
- `e8b1b2f` — mandatory tenant gate and CI assertion.
- Documentation and this report are the following dedicated documentation commit.

## Red / green evidence

- `node --test packages/database/test/integration/canonical-order-storage.test.mjs`: initial RED 0/1, expected `to_regclass(OrderListing)` null because the table was absent.
- The same command after implementation: GREEN 10/10 (9 behavioral subtests plus parent), zero failed/skipped. Includes all six statuses, explicit unknown values and provider anomaly, amount/time/identity negatives, 500-line boundary and 501st rollback, duplicate identity, aggregate overflow, READ COMMITTED requirement, genuinely overlapping concurrent child deletions, atomic child replacement/rollback, tenant/store RLS, worker/reader DML denial, connection revocation/reset and deployed Prisma drift.
- `node --test tests/ci-workflow.test.mjs`: RED 3/4 before registering the suite; GREEN 4/4 after registration, preserving Product RPC gate assertions.
- `pnpm --filter @shopmate/database build`: passed (Prisma generation and TypeScript build), also rebuilt after the main merge by the full gate.
- `pnpm --filter @shopmate/database exec prisma validate`: passed after merge.
- `pnpm --filter @shopmate/database lint`: passed after fixing explicit Node imports.
- `pnpm exec prettier --check packages/database/test/integration/canonical-order-storage.test.mjs tests/ci-workflow.test.mjs scripts/test-tenant-database.mjs docs/architecture/2026-10-09-canonical-order-storage.md`: passed.
- Focused test's actual `prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code --script`: empty migration, passed.

## Full gate pending root handoff

`pnpm test:tenant` runs in exec session **84150**, launched after commit `e8b1b2f` and after the ordinary main merge. It rebuilt contracts/database, then loaded the updated gate script containing order and Product RPC suites. Root authorized this sole full-gate run and owns the pending process. It is still running at this report handoff; no final total or success claim is made. Earlier gate suites were passing in observed output; output truncation means no complete aggregate count can be responsibly reported yet.

## Review notes / limits

Database cleanup uses the dedicated loopback `shopmate_tenant_test_orders` name, guarded before creation and cleanup, and only drops it if this run successfully created it. External identifiers retain literal composed/decomposed Unicode distinctions; product/SKU presence is independent.

Nullable paid/refunded/paidAt/sourceVersion/sourceUpdatedAt fields are asserted as NULL, never converted to zero. Quality flags and payment exceptions exactly follow Connector semantics. `TIMESTAMPTZ(3)` stores milliseconds but does not validate original high-precision textual input; a later restricted RPC must handle normalization. Deferred snapshot checks enforce final economics, not worker lease fencing. Root owns independent review, PR creation/latest CI and authorized merge. No PR or merge-to-main was performed by this agent.
