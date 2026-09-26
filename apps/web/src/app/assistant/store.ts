import type {
  AssistantIdentity,
  WorkspaceSnapshot,
  WorkspaceSession,
  WorkspaceMessage,
  ProductCopyRequest,
  DashboardInsightPreviewResponse,
  DashboardChartView,
} from "@shopmate/contracts";
import {
  EMPTY_WORKSPACE,
  readWorkspace,
  writeWorkspace,
  workspaceKey,
  newId,
  historyFor,
} from "./model";
import { runAssistant, AssistantTransportError } from "./transport";
import { chartFollowupMessage, chartFollowupView } from "../chart-followup";

export type WorkspaceState = WorkspaceSnapshot & {
  ready: boolean;
  error: string;
  warning: string;
  runningId: string;
  progress: string;
  pendingArtifact?: { preview: DashboardInsightPreviewResponse; view: DashboardChartView };
};
export const INITIAL_STATE: WorkspaceState = {
  ...EMPTY_WORKSPACE,
  ready: false,
  error: "",
  warning: "",
  runningId: "",
  progress: "",
};

export class AssistantStore {
  private state: WorkspaceState = INITIAL_STATE;
  private readonly listeners = new Set<() => void>();
  private key = "";
  private controller: AbortController | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly addedArtifacts = new Set<DashboardInsightPreviewResponse>();
  constructor(
    private readonly storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> | undefined,
    private readonly run = runAssistant,
  ) {}
  getSnapshot = () => this.state;
  ownsStorageKey=(key:string|null)=>Boolean(this.key)&&key===this.key;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private publish(patch: Partial<WorkspaceState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((l) => l());
  }
  private save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flush(), 300);
  }
  flush = () => {
    clearTimeout(this.saveTimer);
    if (!this.key || !this.state.ready) return;
    try {
      if (!this.storage) throw new Error("Storage unavailable");
      this.storage.setItem(this.key, writeWorkspace(this.snapshot()));
      if (this.state.warning) this.publish({ warning: "" });
    } catch {
      this.publish({ warning: "历史暂未保存到此设备，请检查浏览器存储或清理旧会话。" });
    }
  };
  private snapshot(): WorkspaceSnapshot {
    return { version: 1, sessions: this.state.sessions, currentId: this.state.currentId };
  }
  checking() {
    this.publish({ ready: false, error: "" });
  }
  activate(identity: AssistantIdentity) {
    const key = workspaceKey(identity);
    if (key === this.key) {
      this.publish({ ready: true, error: "" });
      this.flush();
      return;
    }
    this.controller?.abort();
    this.controller = null;
    clearTimeout(this.saveTimer);
    this.addedArtifacts.clear();
    let snapshot = EMPTY_WORKSPACE,
      warning = "";
    try {
      snapshot = readWorkspace(this.storage?.getItem(key) ?? null);
    } catch {
      warning = "本地历史无法读取，已开启空白工作区。";
    }
    snapshot = {
      ...snapshot,
      sessions: snapshot.sessions.map((session) => {
        const last = session.messages[session.messages.length - 1];
        if (last?.role !== "user") return session;
        return {
          ...session,
          draft: last.content.slice(0, 2000),
          messages: [
            ...session.messages,
            {
              id: newId(),
              role: "assistant" as const,
              content: "上次连接已中断，没有自动重发。",
              status: "stopped" as const,
              createdAt: new Date().toISOString(),
            },
          ].slice(-100),
        };
      }),
    };
    this.key = key;
    this.publish({
      ...INITIAL_STATE,
      ...snapshot,
      ready: true,
      warning,
      pendingArtifact: undefined,
    });
  }
  unavailable(message: string) {
    this.publish({ ready: false, error: message });
  }
  reportError(message:string){this.publish({error:message});}
  clear = () => {
    this.controller?.abort();
    this.controller = null;
    clearTimeout(this.saveTimer);
    this.addedArtifacts.clear();
    let warning = "";
    try {
      if (this.key) this.storage?.removeItem(this.key);
    } catch {
      warning = "本地记录清理失败，请在浏览器设置中清除此网站的数据。";
    }
    this.key = "";
    this.publish({
      ...INITIAL_STATE,
      error: "请登录后使用经营助手。",
      warning,
      pendingArtifact: undefined,
    });
  };
  create = () => {
    if (!this.state.ready) return;
    if (this.state.sessions.length >= 30) {
      this.publish({ error: "最多保留 30 个会话，请先删除不需要的历史。" });
      return;
    }
    const session: WorkspaceSession = {
      id: newId(),
      title: "新对话",
      draft: "",
      updatedAt: new Date().toISOString(),
      messages: [],
    };
    this.publish({ sessions: [session, ...this.state.sessions], currentId: session.id, error: "" });
    this.save();
  };
  select = (id: string) => {
    if (this.state.sessions.some((s) => s.id === id)) {
      this.publish({ currentId: id, error: "" });
      this.save();
    }
  };
  rename = (id: string, title: string) => {
    if (title.trim()) this.updateSession(id, (s) => ({ ...s, title: title.trim().slice(0, 80) }));
  };
  remove = (id: string) => {
    if (this.state.runningId === id) this.stop();
    const sessions = this.state.sessions.filter((s) => s.id !== id);
    this.publish({
      sessions,
      currentId: this.state.currentId === id ? (sessions[0]?.id ?? "") : this.state.currentId,
    });
    this.save();
  };
  setDraft = (draft: string) => {
    if (!this.state.ready) return;
    if (!this.state.currentId) this.create();
    this.updateSession(this.state.currentId, (s) => ({ ...s, draft: draft.slice(0, 2000) }));
  };
  private updateSession(id: string, update: (s: WorkspaceSession) => WorkspaceSession) {
    this.publish({ sessions: this.state.sessions.map((s) => (s.id === id ? update(s) : s)) });
    this.save();
  }
  private append(id: string, message: WorkspaceMessage) {
    this.updateSession(id, (s) => ({
      ...s,
      messages: [...s.messages, message],
      updatedAt: new Date().toISOString(),
    }));
  }
  stop = () => {
    if (!this.controller) return;
    this.controller.abort();
    this.controller = null;
    this.append(this.state.runningId, {
      id: newId(),
      role: "assistant",
      content: "已停止。本次已发出的模型调用可能已产生费用。",
      status: "stopped",
      createdAt: new Date().toISOString(),
    });
    this.publish({ runningId: "", progress: "" });
  };
  stageArtifact = (preview: DashboardInsightPreviewResponse, view: DashboardChartView) =>
    this.publish({ pendingArtifact: { preview, view } });
  clearArtifact = () => this.publish({ pendingArtifact: undefined });
  isArtifactAdded = (preview: DashboardInsightPreviewResponse) => this.addedArtifacts.has(preview);
  markArtifactAdded = (preview: DashboardInsightPreviewResponse) => {
    this.addedArtifacts.add(preview);
    this.publish({});
  };
  setChartView = (messageId: string, chartView: DashboardChartView) =>
    this.updateSession(this.state.currentId, (s) => ({
      ...s,
      messages: s.messages.map((m) => (m.id === messageId ? { ...m, chartView } : m)),
    }));
  private localChartFollowup(session: WorkspaceSession, prompt: string): boolean {
    const view = chartFollowupView(prompt);
    if (!view) return false;
    const message = [...session.messages].reverse().find((m) => m.insightPreview);
    const response = chartFollowupMessage(message?.insightPreview, view);
    if (response.compatible && message) this.setChartView(message.id, view);
    this.append(session.id, {
      id: newId(),
      role: "user",
      content: prompt,
      status: "complete",
      createdAt: new Date().toISOString(),
    });
    this.append(session.id, {
      id: newId(),
      role: "assistant",
      content: response.content,
      status: "complete",
      createdAt: new Date().toISOString(),
    });
    this.updateSession(session.id, (s) => ({ ...s, draft: "" }));
    return true;
  }

  async submit(content?: string, productCopy?: ProductCopyRequest) {
    if (!this.state.ready || this.state.runningId) return;
    if (!this.state.currentId) this.create();
    const session = this.state.sessions.find(s => s.id === this.state.currentId);
    const prompt = (content ?? session?.draft ?? "").trim();
    if (!session || !prompt || !this.canSubmit(session, prompt)) return;
    if (!productCopy && this.localChartFollowup(session, prompt)) return;
    const controller = this.beginRun(session, prompt);
    const timer = setTimeout(() => this.expireRun(session.id, prompt, controller), 190000);
    try {
      const reply = await this.run({
        requestId: newId(), message: {role: "user", content: prompt},
        history: historyFor(session.messages),
        ...(session.query ? {insightQuery: session.query} : {}),
        ...(productCopy ? {productCopy} : {}),
      }, controller.signal, event => {
        if (this.controller === controller && "label" in event) this.publish({progress: event.label});
      });
      if (this.controller !== controller || controller.signal.aborted) return;
      this.append(session.id, {...reply, id: newId(), status: "complete", createdAt: new Date().toISOString()});
      const query = reply.insightQuery ?? reply.insightPreview?.query;
      if (query) this.updateSession(session.id, s => ({...s, query}));
    } catch (error) {
      if (this.controller === controller && !controller.signal.aborted) this.failRun(session.id, prompt, error);
    } finally {
      clearTimeout(timer);
      if (this.controller === controller) this.finishRun();
    }
  }

  private canSubmit(session: WorkspaceSession, prompt: string): boolean {
    if (prompt.length > 2000 || session.messages.length > 98) {
      this.publish({error: "消息或会话过长，请缩短内容或新建对话。"});
      return false;
    }
    try { writeWorkspace(this.snapshot()); return true; }
    catch { this.publish({error: "历史已达到存储上限，请先删除旧会话。"}); return false; }
  }
  private beginRun(session: WorkspaceSession, prompt: string): AbortController {
    const controller = new AbortController();
    this.controller = controller;
    this.updateSession(session.id, s => ({...s, draft: "", title: s.messages.length ? s.title : prompt.slice(0, 32)}));
    this.append(session.id, {id: newId(), role: "user", content: prompt, status: "complete", createdAt: new Date().toISOString()});
    this.publish({runningId: session.id, progress: "正在连接助手", error: ""});
    return controller;
  }
  private failRun(id: string, prompt: string, error: unknown) {
    if (error instanceof AssistantTransportError && error.status === 401) {this.clear(); return;}
    this.append(id, {id: newId(), role: "assistant", status: "failed", createdAt: new Date().toISOString(), content: error instanceof Error ? error.message : "连接中断，未自动重试。"});
    this.updateSession(id, s => ({...s, draft: s.draft || prompt}));
  }
  private expireRun(id: string, prompt: string, controller: AbortController) {
    if (this.controller !== controller) return;
    controller.abort();
    this.failRun(id, prompt, new Error("连接等待超时，未自动重发。已发送的模型调用可能已产生费用。"));
    this.finishRun();
  }
  private finishRun() {
    this.controller = null;
    this.publish({runningId: "", progress: ""});
    this.flush();
  }
}
