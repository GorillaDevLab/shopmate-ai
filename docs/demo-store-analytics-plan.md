# Demo store analytics implementation

Goal: deterministic, richer synthetic sales data and tenant-scoped store/platform insight queries. No live AI calls, no database writes during development.

1. Add failing fixture tests in packages/database/test/analytics-demo.test.mjs: deterministic dates, two tenants, 30 products and 60 SKUs each, six stores, consistent integer money, paid/cancelled orders, stable IDs across dates.
2. Add Store and optional Order.storeId with composite tenant FK; additive SQL migration only. Preserve legacy orders as unassigned.
3. Implement generator in packages/database/src/analytics-demo-data.ts. Add a separate explicit seed command with dry-run default, dedicated demo IDs and guarded transactional upserts. No deletes or startup hooks.
4. Add store/platform reader tests. Implement bounded, paid-only Prisma reads with authenticated merchantId and store ownership validation. Enable only supported DSL dimensions and filters; keep arbitrary SQL disabled.
5. Wire the reader into existing insight preview execution so generated charts use actual query results. Existing pie/report contracts stay compatible in this first data phase.
6. Run unit tests, Prisma validation/generation, TypeScript and lint. Document exact seed usage and limitations. Do not deploy or run migration/seed without identifying an isolated database target.

UI implemented: responsive left navigation and client-only bar/donut comparison switching on the existing pie result contract. Long gallery previews remain scrollable. A new natural-language time-series chart contract is not included. Verify UI with a local mock-only server, never a paid AI endpoint.
