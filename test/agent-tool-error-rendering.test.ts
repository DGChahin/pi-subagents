import { describe, expect, it, vi } from "vitest";
import subagentsExtension from "../src/index.js";

const theme = {
  fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
  bold: (text: string) => `*${text}*`,
} as any;

function notificationRenderer() {
  const renderers = new Map<string, any>();
  const pi = {
    registerMessageRenderer: vi.fn((type: string, renderer: any) => renderers.set(type, renderer)),
    registerMarkdownTransformer: vi.fn(),
    registerTool: vi.fn(),
    registerCommand: vi.fn(),
    on: vi.fn(),
    events: { emit: vi.fn(), on: vi.fn(() => vi.fn()) },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  } as any;
  subagentsExtension(pi);
  return renderers.get("subagent-notification");
}

function render(status: "error" | "stopped" | "aborted", resultPreview: string): string {
  const renderer = notificationRenderer();
  return renderer(
    {
      details: {
        id: "agent-1",
        description: "Probe repository",
        status,
        toolUses: 0,
        turnCount: 1,
        totalTokens: 0,
        durationMs: 10,
        resultPreview,
      },
    },
    { expanded: false },
    theme,
  )
    .render(120)
    .join("\n");
}

describe("background Agent error rendering", () => {
  it.each(["error", "stopped", "aborted"] as const)("shows the real result preview for a %s completion", (status) => {
    const message = 'Cannot run with isolation: "worktree" — Git probe failed.';
    const output = render(status, message);

    expect(output).toContain(`<error>✗</error> *Probe repository* <dim>${status}</dim>`);
    expect(output).toContain(message);
    expect(output).not.toContain("Aborted (max turns exceeded)");
  });
});
