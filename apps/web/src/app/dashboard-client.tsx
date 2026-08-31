"use client";

import type { AnalyticsDashboardResponse } from "@shopmate/contracts";
import { useEffect, useRef, useState } from "react";

import { Dashboard } from "./dashboard";
import { fetchDashboard, isAbortError } from "./dashboard-api";

type ClientState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly data: AnalyticsDashboardResponse }
  | { readonly status: "empty"; readonly data: AnalyticsDashboardResponse }
  | { readonly status: "error" };

export function DashboardClient({ asOfDate = shanghaiToday() }: { asOfDate?: string }) {
  const { state, retry } = useDashboard(asOfDate);
  return (
    <Dashboard
      state={state.status}
      data={"data" in state ? state.data : undefined}
      onRetry={retry}
    />
  );
}

function useDashboard(asOfDate: string) {
  const [state, setState] = useState<ClientState>({ status: "loading" });
  const controllerRef = useRef<AbortController | null>(null);
  const requestIdRef = useRef(0);

  const applyData = (data: AnalyticsDashboardResponse, requestId: number) => {
    if (requestId !== requestIdRef.current) return;
    setState(isEmptyDashboard(data) ? { status: "empty", data } : { status: "ready", data });
  };

  const applyError = (error: unknown, requestId: number) => {
    if (isAbortError(error) || requestId !== requestIdRef.current) return;
    setState({ status: "error" });
  };

  useEffect(() => {
    const activeControllerRef = controllerRef;
    const controller = startRequest(asOfDate, controllerRef, requestIdRef, applyData, applyError);
    return () => {
      activeControllerRef.current?.abort();
      controller.abort();
    };
  }, [asOfDate]);

  const retry = () => {
    setState({ status: "loading" });
    startRequest(asOfDate, controllerRef, requestIdRef, applyData, applyError);
  };

  return { state, retry };
}

function startRequest(
  asOfDate: string,
  controllerRef: { current: AbortController | null },
  requestIdRef: { current: number },
  onData: (data: AnalyticsDashboardResponse, requestId: number) => void,
  onError: (error: unknown, requestId: number) => void,
): AbortController {
  controllerRef.current?.abort();
  const controller = new AbortController();
  controllerRef.current = controller;
  const requestId = ++requestIdRef.current;
  void fetchDashboard(asOfDate, controller.signal).then(
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
