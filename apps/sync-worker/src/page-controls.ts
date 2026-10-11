import type { ReadOptions } from "@shopmate/contracts";
export interface PageRunControls {
  readonly maxPages?: number;
  readonly budgetMs?: number;
  readonly signal?: AbortSignal;
}
export type PageRunReason = "SUCCEEDED" | "PAGE_LIMIT" | "BUDGET" | "STOPPED";
export class PageRunPause extends Error {
  constructor(readonly reason: "BUDGET" | "STOPPED") {
    super(reason);
  }
}
export function boundedControls(input: PageRunControls, absoluteDeadline?: number) {
  const maxPages = input.maxPages ?? 100,
    budgetMs = input.budgetMs ?? 60000;
  if (
    !Number.isInteger(maxPages) ||
    maxPages < 1 ||
    maxPages > 1000 ||
    !Number.isInteger(budgetMs) ||
    budgetMs < 1 ||
    budgetMs > 3600000 ||
    (absoluteDeadline !== undefined &&
      (!Number.isSafeInteger(absoluteDeadline) || absoluteDeadline < 0))
  )
    throw new Error("SYNC_RUN_INPUT_INVALID");
  return {
    maxPages,
    deadline: Math.min(Date.now() + budgetMs, absoluteDeadline ?? Infinity),
    signal: input.signal,
  };
}
export function checkRun(deadline: number, signal?: AbortSignal): void {
  if (signal?.aborted) throw new PageRunPause("STOPPED");
  if (Date.now() >= deadline) throw new PageRunPause("BUDGET");
}
/** The runner's deadline remains effective even when an adapter ignores its signal. */
export async function controlled<T>(
  operation: Promise<T>,
  deadline: number,
  signal?: AbortSignal,
): Promise<T> {
  checkRun(deadline, signal);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stop: (() => void) | undefined;
  const paused = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new PageRunPause("BUDGET")),
      Math.max(0, deadline - Date.now()),
    );
    stop = () => reject(new PageRunPause("STOPPED"));
    signal?.addEventListener("abort", stop, { once: true });
  });
  try {
    const result = await Promise.race([operation, paused]);
    checkRun(deadline, signal);
    return result;
  } finally {
    clearTimeout(timer);
    if (stop) signal?.removeEventListener("abort", stop);
  }
}
export async function retryWait(
  delay: number | null,
  deadline: number,
  signal?: AbortSignal,
): Promise<void> {
  checkRun(deadline, signal);
  if (delay === null) return;
  if (!Number.isInteger(delay) || delay < 1 || delay > 86400000)
    throw new Error("SYNC_CONNECTOR_INVALID_RESPONSE");
  const bounded = Math.min(delay, Math.max(0, deadline - Date.now()));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await controlled(
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, bounded);
      }),
      deadline,
      signal,
    );
  } finally {
    clearTimeout(timer);
  }
}
export function pageOptions(pageId: string, deadline: number, signal?: AbortSignal): ReadOptions {
  const timeout = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
  return {
    requestId: pageId,
    deadlineAt: new Date(deadline).toISOString(),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  };
}
