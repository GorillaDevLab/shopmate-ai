# Bounded mock causal reducer

`createCausalReducer(config, hydration?)` applies one existing `TimelineEvent` at a time. It shares `applyTimelineEvent` with offline replay, generates and deeply freezes one static catalog, and makes no database calls or full-history generator calls.

Hydration is a closed DTO containing bounded `orders`, `inventory`, and an optional `lastEvent: { at, kind, key }` checkpoint. Database-assigned source version strings are accepted. Records must belong to the configured external store and frozen catalog, have canonical known UTC source times and known causal quantities, and preserve order amounts, line ownership, warehouse, safety stock, and lead time. Unknown nullable contract fields are rejected rather than converted to zero. Input records are copied before storage.

`apply(event)` returns copied, deeply frozen mutations `{ kind, occurredAt, after }`. Accepted order transitions include a partial return's source-time update. Inventory rows are emitted only when the shared replay writes an inventory ledger effect; refund rows require a real refund effect. Every emitted source version is null so the later database append allocates it. Source times remain actual event times.

The state holds at most `7 * ceil(dailyOrders * 1.35)` orders (maximum 2,835), and at most the frozen catalog's 300 SKU balances. An order is pruned only when `orderedAt + 5 days` is strictly earlier than the next event; the exact five-day return boundary remains available. Scratch replay state contains only the relevant order, economics, balance, and transient effects. It does not retain ledger or refund history.

Lost-demand reserves and orphan later order events preserve offline no-op behavior. Opening RESTOCK can establish a known balance; missing balances do not become invented reserve capacity. Existing orders requiring inventory movement must have a known balance. Invalid inputs, chronology, causal status, mismatched refunds, duplicate hydration, and capacity overflow throw before accepted state changes.

`snapshot()` returns an owned bounded DTO suitable for restart. Restore the checkpoint to preserve strict monotonicity across replay groups. Without a checkpoint, hydrated facts still cannot be overwritten by an earlier event. Causal ordering reuses the existing offline timestamp/kind/key comparator, including its UTF-16 key comparison; later publication timestamp groups independently sort using UTF-8 and assign ordinals. This reducer does not assign ordinals or publish records.

Validation uses focused API unit tests against the offline oracle for all four profiles, continuous versus repeatedly restarted effects/state, conservation, stockouts, cancellation, full and partial refunds/returns, five-day boundaries, ownership, unknown facts, timestamps, and budgets. This pure unit introduces no migration or deployment requirement.
