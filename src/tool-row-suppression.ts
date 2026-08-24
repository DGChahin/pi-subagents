import { ToolExecutionComponent } from "@earendil-works/pi-coding-agent";

type ToolRowRender = ToolExecutionComponent["render"];

interface ToolRowPatchState {
  owners: Set<symbol>;
  previousRender: ToolRowRender;
  render: ToolRowRender;
}

const PATCH_STATE_KEY: unique symbol = Symbol.for("pi-subagents:tool-row-suppression");
type PatchRegistry = typeof globalThis & { [PATCH_STATE_KEY]?: ToolRowPatchState };

/**
 * Temporarily hide every Pi TUI tool row without replacing any tool definition.
 * Remove this compatibility patch when Pi provides a renderer-only extension API:
 * https://github.com/earendil-works/pi/issues/8347
 */
export function suppressToolExecutionRows(): () => void {
  const prototype = ToolExecutionComponent.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "render");
  if (!descriptor?.writable || typeof prototype.render !== "function") {
    console.warn("[pi-subagents] Pi's tool-row renderer cannot be patched; individual tool rows remain visible.");
    return () => {};
  }

  const registry = globalThis as PatchRegistry;
  let state = registry[PATCH_STATE_KEY];
  if (!state || prototype.render !== state.render) {
    const owners = new Set<symbol>();
    const previousRender = prototype.render;
    const render: ToolRowRender = function (this: ToolExecutionComponent, width: number): string[] {
      return owners.size > 0 ? [] : previousRender.call(this, width);
    };
    state = { owners, previousRender, render };
    registry[PATCH_STATE_KEY] = state;
    prototype.render = render;
  }

  const owner = Symbol("pi-subagents:tool-row-suppression-owner");
  state.owners.add(owner);
  let released = false;

  return () => {
    if (released) return;
    released = true;
    state.owners.delete(owner);
    if (state.owners.size > 0) return;
    if (prototype.render === state.render) prototype.render = state.previousRender;
    if (registry[PATCH_STATE_KEY] === state) delete registry[PATCH_STATE_KEY];
  };
}
