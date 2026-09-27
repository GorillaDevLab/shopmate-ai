"use client";

import type { DashboardInsightQuery, DashboardInsightResult } from "@shopmate/contracts";
import { DashboardInsightQuerySchema } from "@shopmate/contracts";
import { useRef, useState } from "react";

import { executeDashboardInsight, generateDashboardInsight } from "../../dashboard-insight-api";
import { isAbortError } from "../../dashboard-api";
import { applyConfig, type ConfigPatch } from "./explore-model";
import { ExploreView } from "./explore-view";

export type ExploreState =
  | { readonly status: "idle" }
  | { readonly status: "generating"; readonly question: string }
  | {
      readonly status: "ready";
      readonly question: string;
      readonly query: DashboardInsightQuery;
      readonly result: DashboardInsightResult;
      readonly updating: boolean;
      readonly updateError?: string;
    }
  | {
      readonly status: "error";
      readonly question: string;
      readonly message: string;
      readonly authRequired: boolean;
    };

export function ExploreClient() {
  const [state, setState] = useState<ExploreState>({ status: "idle" });
  const generate = useGenerate(setState);
  const reconfigure = useReconfigure(state, setState);
  return <ExploreView state={state} onGenerate={generate} onConfigChange={reconfigure} />;
}

type SetState = (update: ExploreState | ((state: ExploreState) => ExploreState)) => void;

/** 生成会调用模型并可能产生费用：进行中不接受重复提交，超时也不自动重试。 */
function useGenerate(setState: SetState) {
  const pending = useRef(false);
  return async (question: string) => {
    if (pending.current) return;
    pending.current = true;
    setState({ status: "generating", question });
    try {
      const preview = await generateDashboardInsight(question);
      setState({
        status: "ready",
        question,
        query: preview.query,
        result: preview.result,
        updating: false,
      });
    } catch (error: unknown) {
      setState({
        status: "error",
        question,
        message: errorMessage(error, "暂时无法生成图表，请重试"),
        authRequired: statusOf(error) === 401,
      });
    } finally {
      pending.current = false;
    }
  };
}

/** 调整配置只重新执行结构化查询，不再调用模型；新请求会中止尚未返回的旧请求。 */
function useReconfigure(state: ExploreState, setState: SetState) {
  const controller = useRef<AbortController | null>(null);
  return async (patch: ConfigPatch) => {
    if (state.status !== "ready") return;
    const parsed = DashboardInsightQuerySchema.safeParse(applyConfig(state.query, patch));
    if (!parsed.success) {
      setState({ ...state, updateError: "这组配置无效，请检查日期范围" });
      return;
    }
    controller.current?.abort();
    const active = new AbortController();
    controller.current = active;
    setState({ ...state, query: parsed.data, updating: true, updateError: undefined });
    try {
      const result = await executeDashboardInsight(parsed.data, active.signal);
      setState((current) =>
        current.status === "ready" && controller.current === active
          ? { ...current, result, updating: false }
          : current,
      );
    } catch (error: unknown) {
      if (isAbortError(error) || controller.current !== active) return;
      setState((current) =>
        current.status === "ready"
          ? {
              ...current,
              // 退回上一组配置，保证面板、图表和“加入看板”用的是同一份查询。
              query: state.query,
              updating: false,
              updateError: errorMessage(error, "更新图表失败，请重试"),
            }
          : current,
      );
    }
  };
}

function statusOf(error: unknown): number | undefined {
  if (!(error instanceof Error)) return undefined;
  const status = (error as Error & { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
