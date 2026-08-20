import { describe, expect, it } from "vitest";
import type { AgentRecord } from "../src/types.js";
import {
  ActivityCardStore,
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
  it("renders live steps, token usage, cost, tools, and streamed thinking", () => {
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
    expect(output).toContain("≈$0.0123");
    expect(output).toContain("thinking: Reviewing the renderer lifecycle across multiple phases");
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
