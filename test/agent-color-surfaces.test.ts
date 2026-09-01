import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerAgents } from "../src/agent-types.js";
import type { AgentConfig, AgentRecord } from "../src/types.js";
import { ConversationViewer } from "../src/ui/conversation-viewer.js";
import { FleetList, type FleetUICtx } from "../src/ui/fleet-list.js";

const TYPE = "colored-reviewer";
const DISPLAY_NAME = "Code Reviewer";
const PURPLE_BACKGROUND = "\u001b[48;2;130;125;189m";

const config: AgentConfig = {
  name: TYPE,
  displayName: DISPLAY_NAME,
  color: "purple",
  description: "Reviews code",
  extensions: false,
  skills: false,
  systemPrompt: "Review code.",
  promptMode: "replace",
};

const theme = {
  fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
  bold: (text: string) => `*${text}*`,
  getBgAnsi: (color: string) => `<${color}>`,
  getColorMode: () => "truecolor" as const,
};

type RenderedComponent = { render(width?: number): string[] };
type WidgetFactory = (
  tui: { terminal: { columns: number; rows?: number }; requestRender: ReturnType<typeof vi.fn> },
  activeTheme: typeof theme,
) => RenderedComponent;
function registerColoredReviewer(color = "purple"): void {
  registerAgents(new Map([[TYPE, { ...config, color }]]));
}

function makeRecord(): AgentRecord {
  return {
    id: "review-1",
    type: TYPE,
    description: "Review this change",
    status: "running",
    toolUses: 0,
    startedAt: Date.now(),
    session: {
      messages: [],
      subscribe: vi.fn(() => vi.fn()),
    } as unknown as AgentRecord["session"],
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
    compactionCount: 0,
  };
}

beforeEach(() => {
  registerColoredReviewer();
});

afterEach(() => {
  registerAgents(new Map());
});

describe("custom agent color runtime surfaces", () => {
  it("renders the FleetView row with the display name and color", () => {
    const record = makeRecord();
    const manager = {
      listAgents: () => [record],
      abort: vi.fn(() => true),
      steer: vi.fn(() => true),
    } as unknown as ConstructorParameters<typeof FleetList>[0];
    const fleet = new FleetList(manager, new Map());
    let factory: WidgetFactory | undefined;
    fleet.setUICtx({
      setWidget: (_key, content) => {
        if (typeof content === "function") factory = content as WidgetFactory;
      },
      onTerminalInput: vi.fn(() => vi.fn()),
      getEditorText: vi.fn(() => ""),
      notify: vi.fn(),
      custom: (() => new Promise<undefined>(() => {})) as FleetUICtx["custom"],
    });

    try {
      fleet.update();
      const output = factory?.({ requestRender: vi.fn(), terminal: { columns: 120, rows: 40 } }, theme)
        .render(120)
        .join("\n");

      expect(output).toContain(DISPLAY_NAME);
      expect(output).toContain(PURPLE_BACKGROUND);

      registerColoredReviewer("invalid");
      const fallback = factory?.({ requestRender: vi.fn(), terminal: { columns: 120, rows: 40 } }, theme)
        .render(120)
        .join("\n");
      expect(fallback).toContain(`<muted>${DISPLAY_NAME}</muted>`);
      expect(fallback).not.toContain(PURPLE_BACKGROUND);
    } finally {
      fleet.dispose();
    }
  });

  it("renders the conversation viewer header with the display name and color", () => {
    const record = makeRecord();
    const viewer = new ConversationViewer(
      { terminal: { rows: 30, columns: 120 }, requestRender: vi.fn() } as unknown as ConstructorParameters<
        typeof ConversationViewer
      >[0],
      record.session!,
      record,
      undefined,
      theme,
      vi.fn(),
    );

    try {
      const output = viewer.render(120).join("\n");
      expect(output).toContain(DISPLAY_NAME);
      expect(output).toContain(PURPLE_BACKGROUND);
    } finally {
      viewer.dispose();
    }
  });
});
