# Pure sync connector composition export

1. Scope: expose the existing approved read-only connector composition to the independent P2 sync process.
2. Package: `@shopmate/api/mock-commerce` resolves to a standalone built ESM entry and matching TypeScript declarations.
3. Runtime surface: export only MockConnectorFactory, PersistentMockClock and MockConnectorError. Resolver, failure loader, clock and restricted binder interfaces are type-only exports.
4. Composition: callers provide their freshly authorized resolver and source-read binder; no application repository or default database connection is constructed by the export.
5. Authority: the existing factory's live scope/configuration fingerprint, tenant read permission and demo environment checks remain unchanged.
6. Clock: callers instantiate an isolated persisted business clock per selected connector; no global process clock is introduced.
7. Reads: existing persistent publication/cursor evidence, strict page mapping and current authorization remain required. There is no synthetic replay fallback.
8. Writes: the factory retains the existing read-only capabilities and write refusal; no worker, signing or source mutation operation is exported.
9. Isolation: a cold built import with all database/model credentials removed succeeded. All 29 relative dependencies were checked for AppModule, bootstrap, Nest core and database-client imports.
10. Verification: contracts/database/API builds, API lint and the existing 95 factory/persistent connector/clock tests passed. The export is additive; no business implementation changed.
11. Delivery: package/entry export and this report are separate commits; independent review and full exact-head CI remain merge gates. No deployment or migration ran.
12. Remaining P2: compose the server-derived bootstrap with this factory and restricted read ports, freeze a common verified published target, run durable synchronization and complete full-profile source-to-sync acceptance.
