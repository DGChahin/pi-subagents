import type { AssistantMessage } from "@earendil-works/pi-ai";
import { AssistantMessageComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { suppressAssistantThinkingRows } from "../src/assistant-thinking-suppression.js";

const ASSISTANT_THINKING_PATCH_STATE_KEY = Symbol.for("pi-subagents:assistant-thinking-suppression");
const originalUpdateContent = AssistantMessageComponent.prototype.updateContent;
let releases: Array<() => void> = [];

function restoreAssistantPatchState(): void {
  for (const release of releases.reverse()) release();
  releases = [];
  AssistantMessageComponent.prototype.updateContent = originalUpdateContent;
  delete (globalThis as Record<PropertyKey, unknown>)[ASSISTANT_THINKING_PATCH_STATE_KEY];
}

function suppress(): () => void {
  const release = suppressAssistantThinkingRows();
  releases.push(release);
  return release;
}

function assistantMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "thinking", thinking: "private reasoning" }],
    api: "test",
    provider: "test",
    model: "test-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 0,
    ...overrides,
  };
}

function render(message: AssistantMessage): string[] {
  return new AssistantMessageComponent(message, true).render(80);
}

beforeEach(() => {
  restoreAssistantPatchState();
  initTheme("dark");
});
afterEach(restoreAssistantPatchState);

describe("suppressAssistantThinkingRows", () => {
  it("renders no rows for thinking-only assistant content", () => {
    suppress();

    expect(render(assistantMessage())).toEqual([]);
  });

  it("renders mixed content like text-only content without a thinking row or spacer", () => {
    suppress();
    const mixed = assistantMessage({
      content: [
        { type: "thinking", thinking: "private reasoning" },
        { type: "text", text: "visible answer" },
      ],
    });
    const textOnly = assistantMessage({ content: [{ type: "text", text: "visible answer" }] });

    expect(render(mixed)).toEqual(render(textOnly));
    expect(render(mixed).join("\n")).toContain("visible answer");
    expect(render(mixed).join("\n")).not.toContain("Thinking...");
  });

  it.each([
    ["error", "provider failed", "Error: provider failed"],
    ["aborted", "request stopped", "request stopped"],
  ] as const)("keeps %s output visible after thinking is removed", (stopReason, errorMessage, expected) => {
    suppress();
    const output = render(assistantMessage({ stopReason, errorMessage }));

    expect(output.join("\n")).toContain(expected);
    expect(output.join("\n")).not.toContain("Thinking...");
  });

  it("does not mutate the input assistant message", () => {
    suppress();
    const input = assistantMessage({
      content: [
        { type: "thinking", thinking: "private reasoning" },
        { type: "text", text: "visible answer" },
      ],
    });
    const before = structuredClone(input);

    render(input);

    expect(input).toEqual(before);
  });

  it("keeps suppression active until both patch owners release", () => {
    const releaseFirst = suppress();
    const suppressedUpdateContent = AssistantMessageComponent.prototype.updateContent;
    const releaseSecond = suppress();

    releaseFirst();
    expect(AssistantMessageComponent.prototype.updateContent).toBe(suppressedUpdateContent);
    expect(render(assistantMessage())).toEqual([]);

    releaseSecond();
    expect(AssistantMessageComponent.prototype.updateContent).toBe(originalUpdateContent);
  });

  it("restores the original rendering behavior after the final release", () => {
    const input = assistantMessage();
    const originalRows = render(input);
    const release = suppress();

    expect(render(input)).toEqual([]);

    release();
    expect(AssistantMessageComponent.prototype.updateContent).toBe(originalUpdateContent);
    expect(render(input)).toEqual(originalRows);
  });
});
