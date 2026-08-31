"use client";

import type { AnalyticsDashboardResponse } from "@shopmate/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

import { Dashboard } from "./dashboard";
import { fetchDashboard, isAbortError } from "./dashboard-api";
import { DashboardRangeControls, rangeLabel, type DashboardRange } from "./dashboard-range";

type ClientState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly data: AnalyticsDashboardResponse }
  | { readonly status: "empty"; readonly data: AnalyticsDashboardResponse }
  | { readonly status: "error"; readonly authRequired: boolean };
type ClientResult = { key: string; state: ClientState };

export function DashboardClient({ asOfDate = shanghaiToday() }: { asOfDate?: string }) {
  // Remount on a new business date so a previous date's selection cannot leak into the next view.
  return <DashboardRangeClient key={asOfDate} asOfDate={asOfDate} />;
}

function DashboardRangeClient({ asOfDate }: { asOfDate: string }) {
  const [range, setRange] = useState<DashboardRange>({ kind: "7", endDate: asOfDate });
  const { state, retry, isRefreshing } = useDashboard(range.endDate, range.startDate);
  return (
    <Dashboard
      state={state.status}
      authRequired={state.status === "error" ? state.authRequired : false}
      isRefreshing={isRefreshing}
      data={"data" in state ? state.data : undefined}
      onRetry={retry}
      periodLabel={rangeLabel(range)}
      controls={<DashboardRangeControls value={range} latestDate={asOfDate} onChange={setRange} />}
    />
  );
}

function useDashboard(asOfDate: string, startDate?: string) {
  const requestKey = `${asOfDate}/${startDate ?? "7"}`;
  const [result, setResult] = useState<ClientResult>({
    key: requestKey,
    state: { status: "loading" },
  });
  const state: ClientState = result.key === requestKey
    ? result.state
    : "data" in result.state
      ? { status: "ready", data: result.state.data }
      : { status: "loading" };
  const controllerRef = useRef<AbortController | null>(null);
  const requestIdRef = useRef(0);
  const { applyData, applyError } = useRequestCallbacks(requestKey, requestIdRef, setResult);

  useEffect(() => {
    const activeControllerRef = controllerRef;
    const activeRequestIdRef = requestIdRef;
    const controller = startRequest(
      asOfDate,
      controllerRef,
      requestIdRef,
      applyData,
      applyError,
      startDate,
    );
    return () => {
      activeControllerRef.current?.abort();
      controller.abort();
      activeRequestIdRef.current++;
    };
  }, [asOfDate, startDate, applyData, applyError]);

  const retry = () => {
    setResult({ key: requestKey, state: { status: "loading" } });
    startRequest(asOfDate, controllerRef, requestIdRef, applyData, applyError, startDate);
  };

  return { state, retry, isRefreshing: result.key !== requestKey };
}

function useRequestCallbacks(
  requestKey: string,
  requestIdRef: { current: number },
  setResult: (result: ClientResult) => void,
) {
  const applyData = useCallback(
    (data: AnalyticsDashboardResponse, requestId: number) => {
      if (requestId !== requestIdRef.current) return;
      setResult({
        key: requestKey,
        state: isEmptyDashboard(data) ? { status: "empty", data } : { status: "ready", data },
      });
    },
    [requestKey, requestIdRef, setResult],
  );
  const applyError = useCallback(
    (error: unknown, requestId: number) => {
      if (isAbortError(error) || requestId !== requestIdRef.current) return;
      setResult({
        key: requestKey,
        state: { status: "error", authRequired: isUnauthorizedError(error) },
      });
    },
    [requestKey, requestIdRef, setResult],
  );
  return { applyData, applyError };
}

function isUnauthorizedError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const status = (error as Error & { status?: unknown }).status;
  return status === 401;
}

function startRequest(
  asOfDate: string,
  controllerRef: { current: AbortController | null },
  requestIdRef: { current: number },
  onData: (data: AnalyticsDashboardResponse, requestId: number) => void,
  onError: (error: unknown, requestId: number) => void,
  startDate?: string,
): AbortController {
  controllerRef.current?.abort();
  const controller = new AbortController();
  controllerRef.current = controller;
  const requestId = ++requestIdRef.current;
  void fetchDashboard(asOfDate, controller.signal, startDate).then(
    (data) => onData(data, requestId),
    (error: unknown) => onError(error, requestId),
  );
  return controller;
}

function isEmptyDashboard(data: AnalyticsDashboardResponse): boolean {
  return (
    data.metrics.every((metric) => metric.value === null || metric.value === 0) &&
    data.trend.every((point) => point.revenueMinor === 0) &&
    data.products.length === 0 &&
    data.inventoryAlerts.length === 0
  );
}

function shanghaiToday(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: "Asia/Shanghai",
  }).formatToParts(now);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}
