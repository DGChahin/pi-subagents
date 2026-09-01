# Contributing to @tintinweb/pi-subagents

This guide exists to save both sides time.

## Philosophy

`pi-subagents` is a [pi](https://pi.dev) extension, and it tries to stay focused:
spawn and orchestrate autonomous sub-agents that feel native to pi, and do that
well. Features that don't serve that goal, or that bolt on unrelated complexity,
are likely to be declined. When in doubt, open an issue and discuss the idea
before writing the code.

The extension deliberately mirrors Claude Code's tool names, calling
conventions, and UI patterns. Changes should respect that compatibility unless
there's a good reason to diverge.

## The One Rule

**You must understand your code.** If you cannot explain what your changes do and
how they interact with the rest of the system, the PR will be closed.

Using AI to write code is fine. Submitting AI-generated slop without
understanding it is not.

## Filing Issues

Keep issues short, concrete, and worth reading.

- Keep it concise. If it does not fit on one screen, it is too long.
- Write in your own voice. If you used an LLM to draft it, review and shape it
  yourself before posting.
- State the bug or request clearly, and explain why it matters.
- For bugs, include a minimal repro: pi version, this extension's version, your
  agent/config, the steps, and the actual vs. expected behavior.
- If you want to implement the change yourself, say so.

For security issues, do **not** open a public issue — see [SECURITY.md](SECURITY.md).

## Before Submitting a PR

For anything beyond a trivial fix, open an issue first so we can agree on the
approach before you invest the time.

Install the locked npm dependencies with `npm ci`. On the managed development host, the global pre-commit hook dispatches to `bin/pre-commit-check`, which runs check-only Biome lint/import-sorting and formatting for staged owned TypeScript files. It does not rewrite or stage files. Use `npm run lint:fix` or `npm run format:fix`, then stage and retry when it reports a failure.

Make sure the full check suite passes locally:

```bash
npm run lint          # check-only Biome lint and import sorting
npm run format:check  # check-only Biome formatting
npm run typecheck     # tsc --noEmit
npm run test          # vitest
npm run build         # tsc
```

Before opening a pull request from this fork, commit all changes and run `bin/pre-pr` from the clean feature worktree. Its default base is `origin/main`; pass `upstream/master` explicitly for an upstream contribution. The gate runs the checks above plus whole-file complexity audit and the offline faux e2e suite. Live-login e2e, publishing, and mutation testing are excluded; mutation is not applicable to this Pi extension/TUI.

If setup is missing, rerun `npm ci` or follow the host guidance printed by the gate. Fix the first reported native check and rerun `bin/pre-pr`; the gate never installs dependencies or publishes.

Other guidelines:

- Keep PRs focused — one logical change per PR. Unrelated refactors make review
  harder and are likely to be split out or declined.
- Add or update tests for behavior you change.
- Match the surrounding code style (enforced by biome).
- Do not edit `CHANGELOG.md`. Changelog entries are added by the maintainer.
- Update the README when you add or change user-facing behavior.

## Questions?

Open an [issue](https://github.com/tintinweb/pi-subagents/issues) — questions and
discussion are welcome.
