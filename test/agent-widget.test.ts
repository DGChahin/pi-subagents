import { describe, expect, it } from "vitest";
import { describeActivity, fgPreservingNestedStyles, formatCost, formatSessionTokens } from "../src/ui/agent-widget.js";

const theme = { fg: (c: string, s: string) => `<${c}>${s}</${c}>`, bold: (s: string) => s };
const ansiTheme = {
  fg: (c: string, s: string) => {
    const codes: Record<string, string> = { dim: "2", warning: "33", accent: "35" };
    return `\u001b[${codes[c] ?? "31"}m${s}\u001b[39m`;
  },
  bold: (s: string) => s,
};

describe("shared activity helpers", () => {
  it("applies threshold colors to context annotations", () => {
    expect(formatSessionTokens(1234, null, theme)).toBe("1.2k token");
    expect(formatSessionTokens(1234, 50, theme)).toBe("1.2k token (<dim>50%</dim>)");
    expect(formatSessionTokens(1234, 70, theme)).toBe("1.2k token (<warning>70%</warning>)");
    expect(formatSessionTokens(1234, 84, theme)).toBe("1.2k token (<warning>84%</warning>)");
    expect(formatSessionTokens(1234, 85, theme)).toBe("1.2k token (<error>85%</error>)");
  });

  it("annotates compaction count alongside context percent", () => {
    expect(formatSessionTokens(1234, null, theme, 1)).toBe("1.2k token (<dim>⇊1</dim>)");
    expect(formatSessionTokens(1234, 45, theme, 2)).toBe("1.2k token (<dim>45%</dim> · <dim>⇊2</dim>)");
    expect(formatSessionTokens(1234, 88, theme, 4)).toBe("1.2k token (<error>88%</error> · <dim>⇊4</dim>)");
    expect(formatSessionTokens(1234, 45, theme, 0)).toBe("1.2k token (<dim>45%</dim>)");
  });

  it("preserves an enclosing style after nested annotation styles reset", () => {
    const tokenText = formatSessionTokens(1234, 70, ansiTheme);

    expect(fgPreservingNestedStyles(ansiTheme, "accent", tokenText)).toBe(
      "\u001b[35m1.2k token (\u001b[33m70%\u001b[39m\u001b[35m)\u001b[39m",
    );
  });

  it("describes active tools and falls back to thinking", () => {
    expect(describeActivity(new Map([["read-1", "read"]]))).toBe("reading…");
    expect(
      describeActivity(
        new Map([
          ["search-1", "grep"],
          ["search-2", "grep"],
        ]),
      ),
    ).toBe("searching 2 patterns…");
    expect(describeActivity(new Map(), "   ")).toBe("thinking…");
  });
});

describe("formatCost", () => {
  it("keeps the precision that distinguishes one run from another", () => {
    expect(formatCost(0.0042)).toBe("~$0.0042");
    expect(formatCost(0.0123)).toBe("~$0.0123");
    expect(formatCost(1.239)).toBe("~$1.24");
  });

  it("never pads a round figure with noise, nor cuts it below cents", () => {
    expect(formatCost(0.05)).toBe("~$0.05");
    expect(formatCost(0.4)).toBe("~$0.40");
    expect(formatCost(12)).toBe("~$12.00");
  });

  it("shows nothing when there is nothing to show", () => {
    expect(formatCost(0)).toBe("");
    expect(formatCost(Number.NaN)).toBe("");
    expect(formatCost(-1)).toBe("");
  });

  it("says a real but tiny cost is tiny, not zero", () => {
    expect(formatCost(0.00002)).toBe("<$0.0001");
    expect(formatCost(0)).toBe("");
  });

  it("marks the figure as an estimate", () => {
    expect(formatCost(0.5).startsWith("~")).toBe(true);
  });
});
