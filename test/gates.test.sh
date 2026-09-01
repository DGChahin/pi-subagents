#!/usr/bin/env bash
set -euo pipefail

project_root=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
temporary_root=$(mktemp -d)
trap 'rm -rf "$temporary_root"' EXIT
export GATE_LOG="$temporary_root/default.log"
export FAIL_MATCH=
export FAKE_BIOME_VERSION=2.4.15
export FAKE_TYPESCRIPT_VERSION=6.0.3
export FAKE_VITEST_VERSION=4.1.10
export EXPECT_SOURCE_BYTES=
export EXPECT_RENAMED_BYTES=
export EXPECT_CONFIG_BYTES=
export EXPECT_LOCK_BYTES=
export GIT_FAIL_MATCH=
export REAL_GIT
REAL_GIT=$(command -v git)

fail() {
  printf 'gate contract: %s\n' "$1" >&2
  exit 1
}

expect_failure() {
  if "$@" >"$temporary_root/failure.out" 2>&1; then
    fail "command unexpectedly succeeded: $*"
  fi
}

expect_failure_matching() {
  local expected=$1
  shift
  if "$@" >"$temporary_root/failure.out" 2>&1; then
    fail "command unexpectedly succeeded: $*"
  fi
  grep -Fq "$expected" "$temporary_root/failure.out" || fail "failure did not report '$expected': $*"
}

make_fake_biome() {
  local target=$1
  cat >"$target" <<'SCRIPT'
#!/usr/bin/env bash
set -euo pipefail
if [ -n "${EXPECT_CONFIG_BYTES:-}" ]; then
  [ "$(cat biome.json)" = "$EXPECT_CONFIG_BYTES" ] || exit 12
fi
if [ -n "${EXPECT_LOCK_BYTES:-}" ]; then
  [ "$(cat package-lock.json)" = "$EXPECT_LOCK_BYTES" ] || exit 13
fi
if [ "${1:-}" = "--version" ]; then
  echo "Version: $FAKE_BIOME_VERSION"
  exit 0
fi
printf 'biome %s\n' "$*" >>"$GATE_LOG"
if [ -n "${EXPECT_SOURCE_BYTES:-}" ] && [[ " $* " = *" src/source.ts "* ]]; then
  [ "$(cat src/source.ts)" = "$EXPECT_SOURCE_BYTES" ] || exit 10
fi
if [ -n "${EXPECT_RENAMED_BYTES:-}" ] && [[ " $* " = *" test/renamed.test.ts "* ]]; then
  [ "$(cat test/renamed.test.ts)" = "$EXPECT_RENAMED_BYTES" ] || exit 11
fi
if [ "${FAIL_MATCH:-}" = "biome:${1:-}" ]; then
  exit 9
fi
SCRIPT
  chmod +x "$target"
}

mkdir -p "$temporary_root/path"
cat >"$temporary_root/path/git" <<'SCRIPT'
#!/usr/bin/env bash
set -euo pipefail
if [ -n "${GIT_FAIL_MATCH:-}" ] && [[ "$*" = "$GIT_FAIL_MATCH"* ]]; then
  exit 86
fi
exec "$REAL_GIT" "$@"
SCRIPT
chmod +x "$temporary_root/path/git"

# Staged adapter: exact index bytes, owned paths, rename/deletion, discovery and setup failures, order, and no writes.
adapter_repo="$temporary_root/adapter"
mkdir -p "$adapter_repo/bin" "$adapter_repo/node_modules/.bin" "$adapter_repo/src" "$adapter_repo/test" "$adapter_repo/dist" "$adapter_repo/media"
cp "$project_root/bin/pre-commit-check" "$adapter_repo/bin/pre-commit-check"
chmod +x "$adapter_repo/bin/pre-commit-check"
make_fake_biome "$adapter_repo/node_modules/.bin/biome"
printf '{}\n' >"$adapter_repo/biome.json"
printf '{"packages":{"node_modules/@biomejs/biome":{"version":"2.4.15"}}}\n' >"$adapter_repo/package-lock.json"
git -C "$adapter_repo" init -q -b main
git -C "$adapter_repo" config user.name Contract
git -C "$adapter_repo" config user.email contract@example.invalid
printf 'export const source = 1;\n' >"$adapter_repo/src/source.ts"
printf 'export const testValue = 1;\n' >"$adapter_repo/test/source.test.ts"
printf 'generated\n' >"$adapter_repo/dist/generated.js"
printf 'media\n' >"$adapter_repo/media/file.ts"
printf 'notes\n' >"$adapter_repo/README.md"
git -C "$adapter_repo" add src/source.ts test/source.test.ts dist/generated.js media/file.ts README.md package-lock.json biome.json
git -C "$adapter_repo" commit -qm initial
run_adapter() {
  (cd "$adapter_repo" && PATH="$temporary_root/path:$PATH" bin/pre-commit-check "$@")
}
GATE_LOG="$temporary_root/adapter-empty.log" run_adapter | grep -q 'no relevant staged'
expect_failure run_adapter unexpected

printf 'export const source = 2;\n' >"$adapter_repo/src/source.ts"
printf 'export const testValue = 2;\n' >"$adapter_repo/test/source.test.ts"
printf '{"formatter":{"enabled":true}}\n' >"$adapter_repo/biome.json"
printf '{"lockfileVersion":3,"packages":{"node_modules/@biomejs/biome":{"version":"2.4.15"}}}\n' >"$adapter_repo/package-lock.json"
printf 'generated changed\n' >"$adapter_repo/dist/generated.js"
printf 'media changed\n' >"$adapter_repo/media/file.ts"
git -C "$adapter_repo" add src/source.ts test/source.test.ts biome.json package-lock.json dist/generated.js media/file.ts
printf 'export const source = 999;\n' >"$adapter_repo/src/source.ts"
printf '{"formatter":{"enabled":false}}\n' >"$adapter_repo/biome.json"
printf '{"lockfileVersion":3,"packages":{"node_modules/@biomejs/biome":{"version":"0.0.0"}}}\n' >"$adapter_repo/package-lock.json"
before_index=$(git -C "$adapter_repo" write-tree)
before_worktree=$(git -C "$adapter_repo" status --porcelain=v1)
EXPECT_SOURCE_BYTES='export const source = 2;' EXPECT_CONFIG_BYTES='{"formatter":{"enabled":true}}' EXPECT_LOCK_BYTES='{"lockfileVersion":3,"packages":{"node_modules/@biomejs/biome":{"version":"2.4.15"}}}' GATE_LOG="$temporary_root/adapter.log" run_adapter >/dev/null
after_index=$(git -C "$adapter_repo" write-tree)
after_worktree=$(git -C "$adapter_repo" status --porcelain=v1)
[ "$before_index" = "$after_index" ] || fail "adapter changed the index"
[ "$before_worktree" = "$after_worktree" ] || fail "adapter changed the worktree"
expected_adapter=$(cat <<'TEXT'
biome check --formatter-enabled=false --no-errors-on-unmatched src/source.ts test/source.test.ts
biome format --no-errors-on-unmatched src/source.ts test/source.test.ts
TEXT
)
[ "$(cat "$temporary_root/adapter.log")" = "$expected_adapter" ] || fail "adapter selected excluded paths or changed stage order"
FAIL_MATCH=biome:check GATE_LOG="$temporary_root/adapter-lint-fail.log" expect_failure run_adapter
FAIL_MATCH=biome:format GATE_LOG="$temporary_root/adapter-format-fail.log" expect_failure run_adapter
FAKE_BIOME_VERSION=0.0.0 expect_failure_matching 'Biome 2.4.15 is required by the staged package-lock.json; found 0.0.0' run_adapter
GIT_FAIL_MATCH='diff --cached --name-only' expect_failure_matching 'could not inspect staged source and test files' run_adapter
git -C "$adapter_repo" update-index --force-remove package-lock.json
expect_failure_matching "could not identify exactly one staged blob for 'package-lock.json'" run_adapter
git -C "$adapter_repo" restore --staged package-lock.json

git -C "$adapter_repo" restore --staged --worktree -- .
git -C "$adapter_repo" mv test/source.test.ts test/renamed.test.ts
printf 'export const renamed = 999;\n' >"$adapter_repo/test/renamed.test.ts"
EXPECT_RENAMED_BYTES='export const testValue = 1;' GATE_LOG="$temporary_root/adapter-rename.log" run_adapter >/dev/null
expected_rename=$(cat <<'TEXT'
biome check --formatter-enabled=false --no-errors-on-unmatched test/renamed.test.ts
biome format --no-errors-on-unmatched test/renamed.test.ts
TEXT
)
[ "$(cat "$temporary_root/adapter-rename.log")" = "$expected_rename" ] || fail "adapter did not validate the staged rename destination"
git -C "$adapter_repo" restore --staged --worktree -- .
git -C "$adapter_repo" rm -q src/source.ts test/source.test.ts
GATE_LOG="$temporary_root/adapter-delete.log" run_adapter | grep -q 'no relevant staged'
git -C "$adapter_repo" restore --staged --worktree -- .
rm "$adapter_repo/node_modules/.bin/biome"
printf 'export const source = 3;\n' >"$adapter_repo/src/source.ts"
git -C "$adapter_repo" add src/source.ts
expect_failure run_adapter

# Full gate fixture with local tools and deterministic command logging.
gate_repo="$temporary_root/gate"
mkdir -p "$gate_repo/bin" "$gate_repo/node_modules/.bin" "$gate_repo/test"
cp "$project_root/bin/pre-pr" "$gate_repo/bin/pre-pr"
chmod +x "$gate_repo/bin/pre-pr"
printf '{"scripts":{},"devDependencies":{"@biomejs/biome":"2.4.15","typescript":"^6.0.0","vitest":"^4.0.18"}}\n' >"$gate_repo/package.json"
printf '{"packages":{"":{"devDependencies":{"@biomejs/biome":"2.4.15","typescript":"^6.0.0","vitest":"^4.0.18"}},"node_modules/@biomejs/biome":{"version":"2.4.15"},"node_modules/typescript":{"version":"6.0.3"},"node_modules/vitest":{"version":"4.1.10"}}}\n' >"$gate_repo/package-lock.json"
printf '{}\n' >"$gate_repo/biome.json"
printf '{}\n' >"$gate_repo/tsconfig.json"
printf 'export default {};\n' >"$gate_repo/vitest.config.ts"
printf 'export const value = 1;\n' >"$gate_repo/source.ts"
make_fake_biome "$gate_repo/node_modules/.bin/biome"
cat >"$gate_repo/node_modules/.bin/tsc" <<'SCRIPT'
#!/usr/bin/env bash
echo "Version $FAKE_TYPESCRIPT_VERSION"
SCRIPT
cat >"$gate_repo/node_modules/.bin/vitest" <<'SCRIPT'
#!/usr/bin/env bash
echo "vitest/$FAKE_VITEST_VERSION linux-x64 node-v22.0.0"
SCRIPT
chmod +x "$gate_repo/node_modules/.bin/tsc" "$gate_repo/node_modules/.bin/vitest"
cat >"$temporary_root/path/npm" <<'SCRIPT'
#!/usr/bin/env bash
printf 'npm %s\n' "$*" >>"$GATE_LOG"
if [ "${FAIL_MATCH:-}" = "npm:$*" ]; then exit 7; fi
SCRIPT
cat >"$temporary_root/path/code-audit" <<'SCRIPT'
#!/usr/bin/env bash
printf 'code-audit %s\n' "$*" >>"$GATE_LOG"
if [ "${FAIL_MATCH:-}" = "code-audit" ]; then exit 8; fi
SCRIPT
chmod +x "$temporary_root/path/npm" "$temporary_root/path/code-audit"
git -C "$gate_repo" init -q -b main
git -C "$gate_repo" config user.name Contract
git -C "$gate_repo" config user.email contract@example.invalid
git -C "$gate_repo" add .
git -C "$gate_repo" commit -qm initial
git -C "$gate_repo" update-ref refs/remotes/origin/main HEAD
git -C "$gate_repo" update-ref refs/remotes/upstream/master HEAD
git -C "$gate_repo" switch -qc feature
printf 'export const value = 2;\n' >"$gate_repo/source.ts"
git -C "$gate_repo" add source.ts
git -C "$gate_repo" commit -qm feature
run_gate() {
  (cd "$gate_repo" && PATH="$temporary_root/path:$PATH" GATE_LOG="$temporary_root/gate.log" bin/pre-pr "$@")
}
: >"$temporary_root/gate.log"
run_gate >/dev/null
expected_stages=$(cat <<'TEXT'
npm run lint
npm run format:check
code-audit --base origin/main
npm run typecheck
npm run test
npm run build
npm run test:e2e
TEXT
)
[ "$(cat "$temporary_root/gate.log")" = "$expected_stages" ] || fail "full gate default or stage order changed"
: >"$temporary_root/gate.log"
run_gate upstream/master >/dev/null
grep -qx 'code-audit --base upstream/master' "$temporary_root/gate.log" || fail "explicit upstream contribution base was not preserved"
expect_failure run_gate one two
expect_failure run_gate ""
(cd "$gate_repo/test" && PATH="$temporary_root/path:$PATH" expect_failure ../bin/pre-pr)
expect_failure run_gate missing/ref
FAIL_MATCH='npm:run format:check' expect_failure run_gate
[ "$(tail -n 1 "$temporary_root/gate.log")" = 'npm run format:check' ] || fail "gate did not stop on native failure"
FAIL_MATCH=
FAKE_BIOME_VERSION=0.0.0 expect_failure_matching 'Biome 2.4.15 is required by package-lock.json; found 0.0.0' run_gate
FAKE_TYPESCRIPT_VERSION=0.0.0 expect_failure_matching 'TypeScript 6.0.3 is required by package-lock.json; found 0.0.0' run_gate
FAKE_VITEST_VERSION=0.0.0 expect_failure_matching 'Vitest 4.1.10 is required by package-lock.json; found 0.0.0' run_gate
printf '{"packages":{"":{"devDependencies":{"@biomejs/biome":"0.0.0","typescript":"^6.0.0","vitest":"^4.0.18"}},"node_modules/@biomejs/biome":{"version":"2.4.15"},"node_modules/typescript":{"version":"6.0.3"},"node_modules/vitest":{"version":"4.1.10"}}}\n' >"$gate_repo/package-lock.json"
git -C "$gate_repo" add package-lock.json
git -C "$gate_repo" commit -qm stale-lock
expect_failure_matching 'package.json and package-lock.json disagree on the Biome dependency spec' run_gate
printf '{"packages":{"":{"devDependencies":{"@biomejs/biome":"2.4.15","typescript":"^6.0.0","vitest":"^4.0.18"}},"node_modules/@biomejs/biome":{"version":"2.4.15"},"node_modules/typescript":{"version":"6.0.3"},"node_modules/vitest":{"version":"4.1.10"}}}\n' >"$gate_repo/package-lock.json"
git -C "$gate_repo" add package-lock.json
git -C "$gate_repo" commit -qm restore-lock
GIT_FAIL_MATCH='status --porcelain --untracked-files=all' expect_failure_matching 'could not inspect worktree status' run_gate
GIT_FAIL_MATCH='diff --quiet' expect_failure_matching "could not inspect the committed diff from 'origin/main'" run_gate

# Dirty tracked, staged, untracked, detached, target branch, no diff, and no merge base fail in preflight.
printf 'dirty\n' >>"$gate_repo/source.ts"
expect_failure run_gate
git -C "$gate_repo" checkout -q -- source.ts
printf 'staged\n' >>"$gate_repo/source.ts"
git -C "$gate_repo" add source.ts
expect_failure run_gate
git -C "$gate_repo" restore --staged --worktree -- .
printf 'untracked\n' >"$gate_repo/untracked.txt"
expect_failure run_gate
rm "$gate_repo/untracked.txt"
git -C "$gate_repo" checkout -q --detach
expect_failure run_gate
git -C "$gate_repo" switch -q main
expect_failure run_gate
git -C "$gate_repo" switch -qc no-diff
expect_failure run_gate
empty_tree=$(git -C "$gate_repo" mktree </dev/null)
orphan=$(printf 'orphan\n' | git -C "$gate_repo" commit-tree "$empty_tree")
git -C "$gate_repo" update-ref refs/heads/orphan "$orphan"
git -C "$gate_repo" switch -q feature
expect_failure run_gate orphan

grep -q '"src/\*\*/\*.ts"' "$project_root/biome.json" || fail "Biome source scope is missing"
grep -q '"test/\*\*/\*.ts"' "$project_root/biome.json" || fail "Biome test scope is missing"
if grep -Eq 'dist|media|package-lock|vendor' "$project_root/biome.json"; then
  fail "Biome formatter scope includes generated, media, lockfile, or vendor content"
fi

echo "gate contracts: passed"
