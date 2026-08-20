Launch a new agent to handle complex, multi-step tasks autonomously. Each agent type has specific capabilities and tools available to it.

Available agent types and the tools they have access to:
{{typeList}}

Custom agents can be defined in .pi/agents/<name>.md (project) or {{agentDir}}/agents/<name>.md (global) — they are picked up automatically. Project-level agents override global ones. Creating a .md file with the same name as a default agent overrides it.

When using the Agent tool, specify a subagent_type parameter to select which agent type to use.

## When not to use

If the target is already known, use a direct tool — `read` for a known path, `grep`/`find` for a specific symbol or string. Reserve this tool for open-ended questions that span the codebase, or tasks that match an available agent type.

## Usage notes

- Always include a short (3-5 word) description summarizing what the agent will do (shown in UI).
- Agent calls run in background and return an agent ID immediately. Omit `run_in_background`; an explicit `false` is rejected.
- When you launch multiple independent agents, send them in a single message with multiple tool uses so they run concurrently. If the user asks for agents "in parallel", you MUST use one message with multiple Agent tool use content blocks.
- Successful Agent dispatches terminate the parent only when every finalized tool result in that parallel batch is terminating. A rejected dispatch keeps the parent active so it can correct the call.
- When an agent is done, you receive one concise callback after the parent is idle and any compaction barrier opens. The result is not visible to the user; use `get_subagent_result` for full stored output, then summarize relevant results for them.
- Trust but verify: an agent's summary describes what it intended to do, not necessarily what it did. When an agent writes or edits code, check the actual changes before reporting work as done.
- You will be notified when background work completes — do NOT sleep, poll, or proactively check progress. Continue other work or respond to the user.
- **Don't race**: after launching an agent, you know nothing about its results. Never fabricate or predict them in prose, summaries, or structured output. If the user asks before the completion callback arrives, say the agent is still running — give status, not a guess.
- Use `resume` with an agent ID to continue its stored session in background; the call returns the same ID immediately. A fresh Agent call starts with no memory of prior runs, so its prompt must be self-contained.
- Use steer_subagent to send mid-run messages to a running background agent.
- Clearly tell the agent whether you expect it to write code or just to do research (search, file reads, etc.), since it is not aware of the user's intent.
- If an agent's description says it should be used proactively, try to use it without the user having to ask for it first.
- Use model to specify a different model (as "provider/modelId", or fuzzy e.g. "haiku", "sonnet").
- Use thinking to control extended thinking level.
- Use inherit_context if the agent needs the parent conversation history.{{isolationGuideline}}{{scheduleGuideline}}

## Writing the prompt

Brief the agent like a smart colleague who just walked into the room — it hasn't seen this conversation, doesn't know what you've tried, doesn't understand why this task matters.
- Explain what you're trying to accomplish and why.
- Describe what you've already learned or ruled out.
- Give enough context about the surrounding problem that the agent can make judgment calls rather than just following a narrow instruction.
- If you need a short response, say so ("report in under 200 words").
- Lookups: hand over the exact command. Investigations: hand over the question — prescribed steps become dead weight when the premise is wrong.

Terse command-style prompts produce shallow, generic work.

**Never delegate understanding.** Don't write "based on your findings, fix the bug" or "based on the research, implement it." Those phrases push synthesis onto the agent instead of doing it yourself. Write prompts that prove you understood: include file paths, line numbers, what specifically to change.
