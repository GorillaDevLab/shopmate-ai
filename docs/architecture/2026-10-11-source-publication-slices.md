# Bounded source publication plan

Observed failure: a five-day build with 4,656 events reaches publication, but its full physical proof exceeds the existing ten-second statement deadline. Receipt queries also scanned historical prefixes; the indexed suffix query preserves both corruption witnesses and has passed the existing 46 append-port tests.

Use an explicit server-derived claimSlice operation for the source host. New jobs target the earlier of the current business clock and six hours after the last published boundary (or runtime opening). Existing jobs keep their frozen target and checkpoint during takeover. Legacy claim stays compatible. Published certificates describe only their actual completed prefix; repeated host passes fill the remaining history. Do not increase statement or lease timeouts or weaken authorization, proof validation or cancellation.

The target uniqueness key includes targetTime so several immutable certificates can share a business-clock revision. Keep current scope/revision uniqueness, the single-open-job guard and serialized source control. A local transaction flag selects the fixed server budget; callers cannot supply arbitrary target times.

- [ ] Fail-first PostgreSQL coverage: bounded targets, repeated publication at the same clock revision, takeover preserving accepted prefix, legacy claim and revoked/cross-tenant denial.
- [ ] Additive migration and SDK operation; independent logical commit after schema drift and port tests.
- [ ] Host opts into bounded claims; recover opening acknowledgment loss and compare completed multi-slice latest facts to a full generator oracle.
- [ ] Measure the original five-day workload and long profile histories. Register mandatory gates and document throughput before updating PR #469. Full P2 acceptance remains separate.
