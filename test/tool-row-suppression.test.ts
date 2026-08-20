import { ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { suppressToolExecutionRows } from "../src/tool-row-suppression.js";

const TOOL_ROW_PATCH_STATE_KEY = Symbol.for("pi-subagents:tool-row-suppression");
const originalRender = ToolExecutionComponent.prototype.render;
let releases: Array<() => void> = [];

function restorePatchState(): void {
  for (const release of releases.reverse()) release();
  releases = [];
  ToolExecutionComponent.prototype.render = originalRender;
  delete (globalThis as any)[TOOL_ROW_PATCH_STATE_KEY];
}

function suppress(): () => void {
  const release = suppressToolExecutionRows();
  releases.push(release);
  return release;
}

function row(): ToolExecutionComponent {
  return {} as unknown as ToolExecutionComponent;
}

beforeEach(restorePatchState);
afterEach(restorePatchState);

describe("suppressToolExecutionRows", () => {
  it("releases idempotently", () => {
    const release = suppress();
    expect(ToolExecutionComponent.prototype.render.call(row(), 80)).toEqual([]);

    release();
    expect(ToolExecutionComponent.prototype.render).toBe(originalRender);

    release();
    expect(ToolExecutionComponent.prototype.render).toBe(originalRender);
  });

  it("does not restore while another owner remains", () => {
    const releaseFirst = suppress();
    const suppressedRender = ToolExecutionComponent.prototype.render;
    const releaseSecond = suppress();

    releaseFirst();
    expect(ToolExecutionComponent.prototype.render).toBe(suppressedRender);
    expect(ToolExecutionComponent.prototype.render.call(row(), 80)).toEqual([]);

    releaseSecond();
    expect(ToolExecutionComponent.prototype.render).toBe(originalRender);
  });

  it("continues suppressing through a later delegating wrapper", () => {
    const previousRender = vi.fn(() => ["original row"]);
    ToolExecutionComponent.prototype.render = previousRender;
    const release = suppress();
    const suppressedRender = ToolExecutionComponent.prototype.render;
    const delegatingRender: ToolExecutionComponent["render"] = function (this: ToolExecutionComponent, width: number) {
      return suppressedRender.call(this, width);
    };
    ToolExecutionComponent.prototype.render = delegatingRender;

    expect(ToolExecutionComponent.prototype.render.call(row(), 80)).toEqual([]);
    release();
    expect(ToolExecutionComponent.prototype.render).toBe(delegatingRender);
    expect(ToolExecutionComponent.prototype.render.call(row(), 80)).toEqual(["original row"]);
  });

  it("allows a later non-delegating replacement to win load order", () => {
    ToolExecutionComponent.prototype.render = vi.fn(() => ["original row"]);
    const release = suppress();
    const replacementRender = vi.fn(() => ["replacement row"]);
    ToolExecutionComponent.prototype.render = replacementRender;

    expect(ToolExecutionComponent.prototype.render.call(row(), 80)).toEqual(["replacement row"]);
    release();
    expect(ToolExecutionComponent.prototype.render).toBe(replacementRender);
  });
});
