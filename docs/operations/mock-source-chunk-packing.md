# Preparing bounded source appends

`packSourceChunk` is a pure helper for the incremental source host. Supply the full validated scope,
frozen lease base revision/high sequence, accepted checkpoint/hash, deterministic window end and
frozen target, plus an ordered snapshot iterator. It allocates no database sequences and proves no
authorization, lease, certificate or business completeness. The existing worker append protocol
performs those storage checks separately. Generate outside the SQL transaction.

The helper emits at most 100 events and two MiB of the actual UTF-8 JSON append envelope. Every
record still passes the existing source validator and its payload limits. Prepared payloads are
copied so generator mutations cannot change an uncertain-acknowledgement retry. A deferred
iterator is closed; resume by deterministic regeneration from the accepted durable checkpoint,
not from an in-memory iterator position.

Recovery may replay a timestamp group. The helper compares time, phase, PostgreSQL JSONB key text
in UTF-8 C order and numeric ordinal. Initial revision records at the opening checkpoint time
remain eligible. A later revision excludes its published base boundary, including an empty base.
After this revision has accepted facts, greater tuples at the same checkpoint time remain eligible.
A covered gap with an earlier last event excludes all states at its old watermark.

When a chunk fills, its proposed watermark stops at the last included event and remains unsealed.
Only exhaustion advances through the supplied complete window, and only exhaustion of the frozen
target window seals. An empty nonterminal chunk must advance time. These are physical append
rules; the generator must establish that its supplied window contains every required causal event.

Replay admission is bounded by 16,384 examined events and 64 MiB of examined UTF-8 event JSON,
including skipped accepted tuples. Exceeding either budget rejects preparation as `SOURCE_INPUT`
without truncating, sealing, allocating sequences or writing progress. These are explicit worker
preparation limits, not a claim of a universal CPU deadline or support for arbitrary history replay.

This helper does not implement incremental mutation generation, worker scheduling, renewal,
append/publish orchestration, scenario management, canonical ingestion or deployment.
