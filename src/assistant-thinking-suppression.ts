import type { AssistantMessage } from "@earendil-works/pi-ai";
import { AssistantMessageComponent } from "@earendil-works/pi-coding-agent";

type AssistantUpdateContent = AssistantMessageComponent["updateContent"];

interface AssistantThinkingPatchState {
  owners: Set<symbol>;
  previousUpdateContent: AssistantUpdateContent;
  updateContent: AssistantUpdateContent;
}

const PATCH_STATE_KEY: unique symbol = Symbol.for("pi-subagents:assistant-thinking-suppression");
type PatchRegistry = typeof globalThis & { [PATCH_STATE_KEY]?: AssistantThinkingPatchState };

function withoutThinking(message: AssistantMessage): AssistantMessage {
  return {
    ...message,
    content: message.content.filter(content => content.type !== "thinking"),
  };
}

export function suppressAssistantThinkingRows(): () => void {
  const prototype = AssistantMessageComponent.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "updateContent");
  if (!descriptor?.writable || typeof prototype.updateContent !== "function") {
    console.warn("[pi-subagents] Pi's assistant renderer cannot be patched; assistant thinking rows remain visible.");
    return () => {};
  }

  const registry = globalThis as PatchRegistry;
  let state = registry[PATCH_STATE_KEY];
  if (!state || prototype.updateContent !== state.updateContent) {
    const owners = new Set<symbol>();
    const previousUpdateContent = prototype.updateContent;
    const updateContent: AssistantUpdateContent = function (
      this: AssistantMessageComponent,
      message: AssistantMessage,
      isStreaming?: boolean,
    ): void {
      previousUpdateContent.call(this, withoutThinking(message), isStreaming);
    };
    state = { owners, previousUpdateContent, updateContent };
    registry[PATCH_STATE_KEY] = state;
    prototype.updateContent = updateContent;
  }

  const owner = Symbol("pi-subagents:assistant-thinking-suppression-owner");
  state.owners.add(owner);
  let released = false;

  return () => {
    if (released) return;
    released = true;
    state.owners.delete(owner);
    if (state.owners.size > 0) return;
    if (prototype.updateContent === state.updateContent) prototype.updateContent = state.previousUpdateContent;
    if (registry[PATCH_STATE_KEY] === state) delete registry[PATCH_STATE_KEY];
  };
}
