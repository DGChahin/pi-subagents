import { describe, expect, it } from "vitest";
import type { AgentRecord } from "../src/types.js";
import {
  ActivityCardStore,
  activityCardSnapshot,
  createActivityCardComponent,
  toActivityCardData,
} from "../src/ui/activity-card.js";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

function makeRecord(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "agent-1",
    type: "Explore",
    description: "Inspect the TUI",
    status: "running",
    toolUses: 0,
    startedAt: 1_000,
    runRevision: 1,
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
    compactionCount: 0,
    invocation: { thinking: "high", maxTurns: 5, modelName: "haiku" },
    ...overrides,
  } as AgentRecord;
}

describe("activity cards", () => {
  it("renders live steps, token usage, tools, and streamed thinking", () => {
    const record = makeRecord();
    const store = new ActivityCardStore();
    store.begin(record);

    record.toolUses = 1;
    store.apply(record, { type: "tool", activity: { type: "start", toolName: "read" } });
    store.apply(record, { type: "tool", activity: { type: "end", toolName: "read" } });
    store.apply(record, { type: "turn", turnCount: 2 });
    record.lifetimeUsage = {
      input: 1_200,
      output: 300,
      cacheRead: 400,
      cacheWrite: 200,
      cost: 0.0123,
    };
    store.apply(record, {
      type: "usage",
      usage: { input: 1_200, output: 300, cacheRead: 400, cacheWrite: 200, cost: 0.0123 },
    });
    store.apply(record, {
      type: "thinking",
      fullText: "Reviewing the renderer\nlifecycle across multiple phases",
    });

    const component = createActivityCardComponent(store, toActivityCardData(record), theme);
    const lines = component.render(160);
    expect(lines).toHaveLength(5);
    expect(lines.every((line) => !line.includes("\n"))).toBe(true);
    expect(lines[3]).toContain("⎿  thinking: Reviewing the renderer lifecycle across multiple phases");
    const output = lines.join("\n");

    expect(output).toContain("Agent haiku running");
    expect(output).toContain("steps 2/5");
    expect(output).toContain("in 1.2k");
    expect(output).toContain("out 300");
    expect(output).toContain("cache 600");
    expect(output).toContain("tools 1");
    expect(output).not.toContain("$");
    expect(output).toContain("thinking: Reviewing the renderer lifecycle across multiple phases");
  });

  it("keeps durable cards independent across revisions of one agent", () => {
    const first = makeRecord({
      id: "resumable",
      runRevision: 1,
      status: "completed",
      completedAt: 2_000,
    });
    const resumed = makeRecord({
      id: "resumable",
      runRevision: 2,
      status: "running",
      startedAt: 3_000,
    });
    const store = new ActivityCardStore();
    store.begin(first);
    store.apply(first, { type: "text", fullText: "completed first run" });
    store.finish(first);
    const firstData = toActivityCardData(first);
    const firstCard = createActivityCardComponent(store, firstData, theme);

    store.begin(resumed);
    store.apply(resumed, { type: "thinking", fullText: "continuing the resumed run" });
    const resumedData = toActivityCardData(resumed);
    const resumedCard = createActivityCardComponent(store, resumedData, theme);

    expect(firstData.id).toBe("resumable:1");
    expect(resumedData.id).toBe("resumable:2");
    expect(firstCard.render(160).join("\n")).toContain("completed");
    expect(firstCard.render(160).join("\n")).toContain("completed first run");
    expect(firstCard.render(160).join("\n")).not.toContain("continuing the resumed run");
    expect(resumedCard.render(160).join("\n")).toContain("running");
    expect(resumedCard.render(160).join("\n")).not.toContain("completed first run");
    expect(activityCardSnapshot(first, store).id).toBe(firstData.id);
  });

  it("hides estimated cost unless enabled for priced usage", () => {
    const record = makeRecord({
      lifetimeUsage: { input: 1_200, output: 300, cacheWrite: 0, cost: 0.0123 },
    });
    const store = new ActivityCardStore();
    store.begin(record);
    const component = createActivityCardComponent(store, toActivityCardData(record), theme);
    const render = () => component.render(160).join("\n");

    expect(render()).not.toContain("$");
    store.setShowCost(true);
    expect(render()).toContain("~$0.0123");
    store.setShowCost(false);
    expect(render()).not.toContain("$");

    record.lifetimeUsage = { ...record.lifetimeUsage, cost: 0 };
    store.apply(record, {
      type: "usage",
      usage: { input: 1_200, output: 300, cacheWrite: 0, cost: 0 },
    });
    store.setShowCost(true);
    expect(render()).not.toContain("$");
  });

  it("renders and persists context-window utilization", () => {
    const record = makeRecord({ contextPercent: 72.6 });
    const store = new ActivityCardStore();
    store.begin(record);
    const component = createActivityCardComponent(store, toActivityCardData(record), theme);

    expect(component.render(160).join("\n")).toContain("context 73%");

    const snapshot = activityCardSnapshot(record, store);
    expect(snapshot.contextPercent).toBe(72.6);
    const restoredStore = new ActivityCardStore();
    const restored = createActivityCardComponent(restoredStore, snapshot, theme);
    expect(restored.render(160).join("\n")).toContain("context 73%");
  });

  it("clears context utilization after compaction removes the estimate", () => {
    const record = makeRecord({ contextPercent: 64 });
    const store = new ActivityCardStore();
    store.begin(record);
    const component = createActivityCardComponent(store, toActivityCardData(record), theme);
    expect(component.render(160).join("\n")).toContain("context 64%");

    record.contextPercent = undefined;
    store.apply(record, { type: "context", percent: null });

    expect(component.render(160).join("\n")).not.toContain("context ");
    expect(activityCardSnapshot(record, store)).not.toHaveProperty("contextPercent");
  });

  it("normalizes thinking and response activity to one in-place line", () => {
    const thinkingRecord = makeRecord();
    const thinkingStore = new ActivityCardStore();
    thinkingStore.begin(thinkingRecord);
    thinkingStore.apply(thinkingRecord, {
      type: "thinking",
      fullText: "first line\n\nsecond\tline",
    });
    const thinking = createActivityCardComponent(
      thinkingStore,
      toActivityCardData(thinkingRecord),
      theme,
    ).render(160);
    expect(thinking[3]).toContain("⎿  thinking: first line second line");
    expect(thinking[3]).not.toContain("\n");

    const responseRecord = makeRecord({ id: "agent-response" });
    const responseStore = new ActivityCardStore();
    responseStore.begin(responseRecord);
    responseStore.apply(responseRecord, {
      type: "text",
      fullText: "first response\nsecond\tresponse",
    });
    const response = createActivityCardComponent(
      responseStore,
      toActivityCardData(responseRecord),
      theme,
    ).render(160);
    expect(response[3]).toContain("⎿  first response second response");
    expect(response[3]).not.toContain("\n");
  });

  it("keeps response activity when thinking arrives before turn end", () => {
    const record = makeRecord();
    const store = new ActivityCardStore();
    store.begin(record);
    const component = createActivityCardComponent(store, toActivityCardData(record), theme);

    store.apply(record, { type: "text", fullText: "current turn response" });
    expect(component.render(160)[3]).toContain("⎿  current turn response");
    store.apply(record, { type: "thinking", fullText: "later same-turn thinking" });

    const line = component.render(160)[3];
    expect(line).toContain("⎿  current turn response");
    expect(line).not.toContain("thinking: later same-turn thinking");
  });

  it("allows next-turn thinking to supersede the prior response", () => {
    const record = makeRecord();
    const store = new ActivityCardStore();
    store.begin(record);
    const component = createActivityCardComponent(store, toActivityCardData(record), theme);

    store.apply(record, { type: "text", fullText: "completed turn response" });
    store.apply(record, { type: "turn", turnCount: 1 });
    store.apply(record, { type: "thinking", fullText: "next turn thinking" });

    const line = component.render(160)[3];
    expect(line).toContain("⎿  thinking: next turn thinking");
    expect(line).not.toContain("completed turn response");
  });

  it("renders the latest tail of cumulative thinking before response supersedes it", () => {
    const record = makeRecord();
    const store = new ActivityCardStore();
    store.begin(record);
    const component = createActivityCardComponent(store, toActivityCardData(record), theme);

    const oldThinking = "initial prefix " + "older thought ".repeat(12);
    const newestSuffix = "latest tail: inspect lifecycle now";
    const width = newestSuffix.length + 7;
    store.apply(record, { type: "thinking", fullText: oldThinking });
    store.apply(record, {
      type: "thinking",
      fullText: `${oldThinking} ${newestSuffix}`,
    });
    const thinkingLine = component.render(width)[3];
    expect(thinkingLine).toBe(`│  ⎿  …${newestSuffix}`);
    expect(thinkingLine).not.toContain("initial prefix");

    store.apply(record, { type: "text", fullText: "final response supersedes thinking" });
    const responseLine = component.render(140)[3];
    expect(responseLine).toContain("⎿  final response supersedes thinking");
    expect(responseLine).not.toContain("thinking:");
  });

  it("keeps CJK and emoji graphemes intact in a constrained activity tail", () => {
    const record = makeRecord();
    const store = new ActivityCardStore();
    store.begin(record);
    const component = createActivityCardComponent(store, toActivityCardData(record), theme);

    const oldThinking = "旧い前置き ".repeat(12);
    const newestSuffix = "最新尾部 👩‍💻";
    const width = 18;
    store.apply(record, { type: "thinking", fullText: `${oldThinking} ${newestSuffix}` });

    const line = component.render(width)[3];
    expect(line).toBe(`│  ⎿  …${newestSuffix}`);
    expect(line).not.toContain("...");
  });

  it("shows unknown tool activity in the card instead of requiring a tool-specific label", () => {
    const record = makeRecord();
    const store = new ActivityCardStore();
    store.begin(record);
    store.apply(record, { type: "tool", activity: { type: "start", toolName: "web_search" } });

    const component = createActivityCardComponent(store, toActivityCardData(record), theme);
    expect(component.render(160).join("\n")).toContain("web_search");
  });

  it("uses a fallback activity when no thinking or response text is available", () => {
    const record = makeRecord({ invocation: undefined });
    const store = new ActivityCardStore();
    store.begin(record);

    const component = createActivityCardComponent(store, toActivityCardData(record), theme);
    expect(component.render(160).join("\n")).toContain("⎿  thinking…");
  });

  it("restores child identity and final status from durable snapshots", () => {
    const record = makeRecord({ id: "child-1", parentAgentId: "parent-1" });
    const store = new ActivityCardStore();
    store.begin(record);
    const invocationData = toActivityCardData(record);
    record.status = "completed";
    record.completedAt = 2_000;
    store.finish(record);
    const finalData = toActivityCardData(record);
    const restoredStore = new ActivityCardStore();
    const component = createActivityCardComponent(restoredStore, invocationData, theme);
    restoredStore.hydrateFinal(finalData);
    const output = component.render(160).join("\n");
    expect(finalData.parentAgentId).toBe("parent-1");
    expect(output).toContain("completed");
    expect(output).toContain("1.0s");
  });
});
