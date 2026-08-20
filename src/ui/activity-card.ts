import { type Component, truncateToWidth } from "@earendil-works/pi-tui";
import type { CompactionInfo } from "../agent-manager.js";
import type { ToolActivity } from "../agent-runner.js";
import type { AgentInvocation, SubagentType } from "../types.js";
import type { LifetimeUsage, UsageDelta } from "../usage.js";
import { describeActivity, getDisplayName, type Theme, type UICtx } from "./agent-widget.js";

export const ACTIVITY_ENTRY = "subagents:activity";
export const ACTIVITY_FINAL_ENTRY = "subagents:activity-final";

export type ActivityCardStatus = "queued" | "running" | "detached" | "completed" | "steered" | "aborted" | "stopped" | "error";
/** Minimal record shape shared by subagents and the main context agent. */
export interface ActivityCardRecord {
  id: string;
  type: SubagentType;
  description: string;
  status: ActivityCardStatus;
  toolUses: number;
  startedAt: number;
  completedAt?: number;
  error?: string;
  compactionCount: number;
  lifetimeUsage: LifetimeUsage;
  invocation?: AgentInvocation;
  parentAgentId?: string;
  displayName?: string;
}
/** Durable data written when an activity card is created. */
export interface ActivityCardData {
  id: string;
  type: SubagentType;
  description: string;
  startedAt: number;
  status: ActivityCardStatus;
  toolUses: number;
  turnCount: number;
  maxTurns?: number;
  modelName?: string;
  displayName?: string;
  tags?: string[];
  parentAgentId?: string;
  completedAt?: number;
  error?: string;
  compactionCount: number;
  lifetimeUsage: LifetimeUsage;
}

interface ActivityCardState extends ActivityCardData {
  activeTools: Map<string, string>;
  responseText: string;
  thinkingText: string;
}

export type AgentActivityEvent =
  | { type: "tool"; activity: ToolActivity }
  | { type: "text"; fullText: string }
  | { type: "thinking"; fullText: string }
  | { type: "turn"; turnCount: number }
  | { type: "session" }
  | { type: "usage"; usage: UsageDelta }
  | { type: "compaction"; info: CompactionInfo }
  | { type: "start" };

export type ActivityCardListener = () => void;

function copyUsage(usage: LifetimeUsage): LifetimeUsage {
  return {
    input: usage.input,
    output: usage.output,
    cacheWrite: usage.cacheWrite,
    ...(usage.cacheRead !== undefined ? { cacheRead: usage.cacheRead } : {}),
    ...(usage.cost !== undefined ? { cost: usage.cost } : {}),
  };
}

function stateFromData(data: ActivityCardData): ActivityCardState {
  return {
    ...data,
    tags: data.tags ? [...data.tags] : undefined,
    lifetimeUsage: copyUsage(data.lifetimeUsage),
    activeTools: new Map(),
    responseText: "",
    thinkingText: "",
  };
}

/**
 * Live state for every inline activity card. The map is separate from the
 * legacy above-editor widget state so cards remain available after completion.
 */
export class ActivityCardStore {
  private states = new Map<string, ActivityCardState>();
  private listeners = new Set<ActivityCardListener>();

  subscribe(listener: ActivityCardListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    for (const listener of this.listeners) listener();
  }

  get(id: string): ActivityCardState | undefined {
    return this.states.get(id);
  }

  /** Hydrate a card from its durable invocation entry. */
  hydrate(data: ActivityCardData): void {
    const existing = this.states.get(data.id);
    if (!existing) {
      this.states.set(data.id, stateFromData(data));
      return;
    }
    existing.type = data.type;
    existing.description = data.description;
    existing.startedAt = data.startedAt;
    existing.parentAgentId = data.parentAgentId;
    existing.modelName = data.modelName;
    existing.displayName = data.displayName;
    existing.tags = data.tags ? [...data.tags] : undefined;
    if (existing.status !== "running" && existing.status !== "completed") {
      existing.status = data.status;
    }
  }

  /** Apply a final durable snapshot, including state from a prior session. */
  hydrateFinal(data: ActivityCardData): void {
    const existing = this.states.get(data.id);
    if (!existing) {
      this.states.set(data.id, stateFromData(data));
    } else {
      Object.assign(existing, {
        ...data,
        tags: data.tags ? [...data.tags] : undefined,
        lifetimeUsage: copyUsage(data.lifetimeUsage),
      });
      existing.activeTools.clear();
    }
    this.changed();
  }

  begin(record: ActivityCardRecord): void {
    const invocation = record.invocation;
    const current = this.states.get(record.id);
    if (!current) {
      this.states.set(record.id, stateFromData({
        id: record.id,
        type: record.type,
        description: record.description,
        startedAt: record.startedAt,
        status: record.status,
        toolUses: record.toolUses,
        turnCount: 0,
        maxTurns: invocation?.maxTurns,
        modelName: invocation?.modelName,
        displayName: record.displayName,
        tags: invocation ? [
          ...(invocation.thinking ? [`thinking: ${invocation.thinking}`] : []),
          ...(invocation.isolated ? ["isolated"] : []),
          ...(invocation.isolation === "worktree" ? ["worktree"] : []),
        ] : undefined,
        parentAgentId: record.parentAgentId,
        compactionCount: record.compactionCount,
        lifetimeUsage: copyUsage(record.lifetimeUsage),
      }));
    } else {
      current.status = record.status;
      current.startedAt = record.startedAt;
      current.completedAt = record.completedAt;
      current.error = record.error;
      current.toolUses = record.toolUses;
      current.compactionCount = record.compactionCount;
    }
    this.changed();
  }

  apply(record: ActivityCardRecord, event: AgentActivityEvent): void {
    const state = this.states.get(record.id);
    if (!state) {
      this.begin(record);
      this.apply(record, event);
      return;
    }

    switch (event.type) {
      case "tool":
        if (event.activity.type === "start") {
          state.activeTools.set(`${event.activity.toolName}:${Date.now()}:${Math.random()}`, event.activity.toolName);
        } else {
          for (const [key, name] of state.activeTools) {
            if (name === event.activity.toolName) {
              state.activeTools.delete(key);
              break;
            }
          }
        }
        state.toolUses = record.toolUses;
        break;
      case "text":
        state.responseText = event.fullText;
        break;
      case "thinking":
        state.thinkingText = event.fullText;
        break;
      case "turn":
        state.turnCount = event.turnCount;
        break;
      case "usage":
        state.lifetimeUsage = copyUsage(record.lifetimeUsage);
        break;
      case "compaction":
        state.compactionCount = record.compactionCount;
        break;
      case "session":
        break;
      case "start":
        state.status = record.status;
        state.startedAt = record.startedAt;
        state.completedAt = record.completedAt;
        state.error = record.error;
        break;
    }
    this.changed();
  }

  sync(record: ActivityCardRecord): void {
    const state = this.states.get(record.id);
    if (!state) return;
    state.status = record.status;
    state.completedAt = record.completedAt;
    state.error = record.error;
    state.toolUses = record.toolUses;
    state.compactionCount = record.compactionCount;
    state.lifetimeUsage = copyUsage(record.lifetimeUsage);
    this.changed();
  }

  finish(record: ActivityCardRecord): void {
    const state = this.states.get(record.id);
    if (!state) {
      this.begin(record);
      this.finish(record);
      return;
    }
    state.status = record.status;
    state.completedAt = record.completedAt;
    state.error = record.error;
    state.toolUses = record.toolUses;
    state.compactionCount = record.compactionCount;
    state.lifetimeUsage = copyUsage(record.lifetimeUsage);
    state.activeTools.clear();
    this.changed();
  }

  clear(): void {
    this.states.clear();
  }
}

function compactCount(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
  return String(count);
}

function formatCost(cost: number): string {
  if (cost === 0) return "$0.0000";
  if (cost < 1) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}

function formatDuration(startedAt: number, completedAt?: number): string {
  const elapsed = Math.max(0, (completedAt ?? Date.now()) - startedAt);
  return `${(elapsed / 1000).toFixed(1)}s`;
}

function activityText(state: ActivityCardState): string {
  if (state.activeTools.size > 0) return describeActivity(state.activeTools);
  if (state.thinkingText.trim()) return `thinking: ${state.thinkingText}`;
  if (state.responseText.trim()) return state.responseText;
  return "thinking…";
}

function statusIcon(state: ActivityCardState, theme: Theme): string {
  if (state.status === "running" || state.status === "queued") return theme.fg("accent", "●");
  if (state.status === "completed" || state.status === "steered") return theme.fg("success", "✓");
  if (state.status === "detached") return theme.fg("dim", "○");
  return theme.fg("error", "✗");
}

function statusLabel(state: ActivityCardState, theme: Theme): string {
  switch (state.status) {
    case "queued": return theme.fg("muted", "queued");
    case "running": return theme.fg("accent", "running");
    case "detached": return theme.fg("dim", "detached");
    case "steered": return theme.fg("warning", "wrapped up");
    case "completed": return theme.fg("success", "completed");
    case "stopped": return theme.fg("dim", "stopped");
    case "aborted": return theme.fg("error", "aborted");
    case "error": return theme.fg("error", "error");
    default: return theme.fg("dim", state.status);
  }
}

function renderCard(state: ActivityCardState, width: number, theme: Theme): string[] {
  const usage = state.lifetimeUsage;
  const cache = (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
  const steps = state.maxTurns != null ? `steps ${state.turnCount}/${state.maxTurns}` : `steps ${state.turnCount}`;
  const stats = [
    steps,
    `in ${compactCount(usage.input)}`,
    `out ${compactCount(usage.output)}`,
    `cache ${compactCount(cache)}`,
    `tools ${state.toolUses}`,
    `≈${formatCost(usage.cost ?? 0)}`,
    formatDuration(state.startedAt, state.completedAt),
  ].join(" · ");
  const tags = state.tags?.length ? ` ${theme.fg("dim", `[${state.tags.join(", ")}]`)}` : "";
  const model = state.modelName ? ` ${theme.fg("dim", state.modelName)}` : "";
  const name = state.displayName ?? getDisplayName(state.type);
  const error = state.error ? `: ${state.error}` : "";
  const description = `${state.description}${error}`;
  const lines = [
    `${theme.fg("dim", "╭─")} ${statusIcon(state, theme)} ${theme.bold(name)}${model} ${statusLabel(state, theme)}${tags}`,
    `${theme.fg("dim", "│")}  ${theme.fg("muted", description)}`,
    `${theme.fg("dim", "│")}  ${theme.fg("dim", stats)}`,
    `${theme.fg("dim", "│")}  ${theme.fg("dim", `⎿  ${activityText(state)}`)}`,
    theme.fg("dim", "╰─"),
  ];
  return lines.map(line => truncateToWidth(line, width));
}

class ActivityCardComponent implements Component {
  constructor(
    private store: ActivityCardStore,
    private id: string,
    private theme: Theme,
  ) {}

  render(width: number): string[] {
    const state = this.store.get(this.id);
    return state ? renderCard(state, width, this.theme) : [];
  }

  invalidate(): void {}
}

export function createActivityCardComponent(
  store: ActivityCardStore,
  data: ActivityCardData,
  theme: Theme,
): Component {
  store.hydrate(data);
  return new ActivityCardComponent(store, data.id, theme);
}

export function toActivityCardData(record: ActivityCardRecord, turnCount = 0): ActivityCardData {
  const invocation = record.invocation;
  return {
    id: record.id,
    type: record.type,
    description: record.description,
    startedAt: record.startedAt,
    status: record.status,
    toolUses: record.toolUses,
    turnCount,
    maxTurns: invocation?.maxTurns,
    modelName: invocation?.modelName,
    displayName: record.displayName,
    tags: invocation ? [
      ...(invocation.thinking ? [`thinking: ${invocation.thinking}`] : []),
      ...(invocation.isolated ? ["isolated"] : []),
      ...(invocation.isolation === "worktree" ? ["worktree"] : []),
    ] : undefined,
    parentAgentId: record.parentAgentId,
    completedAt: record.completedAt,
    error: record.error,
    compactionCount: record.compactionCount,
    lifetimeUsage: copyUsage(record.lifetimeUsage),
  };
}

export function activityCardSnapshot(record: ActivityCardRecord, store: ActivityCardStore): ActivityCardData {
  const state = store.get(record.id);
  const data = toActivityCardData(record, state?.turnCount ?? 0);
  return {
    ...data,
    toolUses: state?.toolUses ?? data.toolUses,
    turnCount: state?.turnCount ?? data.turnCount,
  };
}

export function formatActivityCardTokens(count: number): string {
  return compactCount(count);
}

/** Keeps transcript components fresh while child sessions stream independently. */
export class ActivityCardTicker {
  private uiCtx: UICtx | undefined;
  private tui: any;
  private interval: ReturnType<typeof setInterval> | undefined;
  private registered = false;
  private readonly key = "subagent-activity-refresh";

  setUICtx(ctx: UICtx): void {
    if (this.uiCtx === ctx) return;
    if (this.registered && this.uiCtx) this.uiCtx.setWidget(this.key, undefined);
    this.uiCtx = ctx;
    this.registered = false;
    this.tui = undefined;
    this.register();
  }

  start(): void {
    if (!this.interval) this.interval = setInterval(() => this.tui?.requestRender(), 80);
    this.register();
  }

  private register(): void {
    if (!this.uiCtx || this.registered) return;
    this.uiCtx.setWidget(this.key, (tui) => {
      this.tui = tui;
      return { render: () => [], invalidate: () => {} };
    }, { placement: "aboveEditor" });
    this.registered = true;
  }

  dispose(): void {
    if (this.interval) clearInterval(this.interval);
    this.interval = undefined;
    if (this.registered && this.uiCtx) this.uiCtx.setWidget(this.key, undefined);
    this.registered = false;
    this.tui = undefined;
  }
}
