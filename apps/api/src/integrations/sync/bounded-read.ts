import type { ReadOptions } from "@shopmate/contracts";

export type BoundedReadOutcome =
  | { readonly status: "RESPONSE"; readonly value: unknown }
  | { readonly status: "ABORTED" | "TIMEOUT" | "TEMPORARY" };

/** Bound an adapter's wall time even if the adapter ignores cancellation. */
export async function boundedRead(
  read: (signal: AbortSignal) => Promise<unknown>,
  options: ReadOptions,
): Promise<BoundedReadOutcome> {
  const controller = new AbortController();
  let settle: ((result: BoundedReadOutcome) => void) | undefined;
  const stopped = new Promise<BoundedReadOutcome>((resolve) => {
    settle = resolve;
  });
  const abort = () => {
    controller.abort();
    settle?.({ status: "ABORTED" });
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  const remaining = Math.max(
    0,
    Math.min(2_147_483_647, Date.parse(options.deadlineAt) - Date.now()),
  );
  const timer = setTimeout(() => {
    controller.abort();
    settle?.({ status: "TIMEOUT" });
  }, remaining);
  const response = Promise.resolve()
    .then(() => read(controller.signal))
    .then(
      (value): BoundedReadOutcome => ({ status: "RESPONSE", value }),
      (): BoundedReadOutcome => ({ status: "TEMPORARY" }),
    );
  try {
    return await Promise.race([response, stopped]);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
  }
}
