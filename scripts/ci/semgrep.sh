#!/usr/bin/env bash
# Static security analysis (Semgrep, free engine). The rules come from semgrep/semgrep-rules at a fixed commit, so a
# run is reproducible and needs no account or registry: only the security rules for JavaScript, TypeScript and leaked
# secrets (the free registry packs p/javascript, p/typescript, p/secrets, p/jwt and p/express draw on the same rules).
# A finding fails the job; a false positive is silenced on its own line with
#   // nosemgrep: <rule-id> -- <one sentence why>
# never by turning a rule off. Same script in every Yadaklavazem repository.
#   scripts/ci/semgrep.sh [paths...]      (default: the whole repository; needs semgrep on PATH)
set -euo pipefail

RULES_REPO="https://github.com/semgrep/semgrep-rules.git"
RULES_COMMIT="${SEMGREP_RULES_COMMIT:-a5ad1714f00c9f7fde980cab0ea1d6dc6d414fd2}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

git init -q "$work/src"
git -C "$work/src" fetch -q --depth 1 "$RULES_REPO" "$RULES_COMMIT"
git -C "$work/src" checkout -q FETCH_HEAD

# Security rules only (not style or best practice), without the rules' own test files. The `audit` rules are left out:
# they flag every file path or log line built from a variable and are meant for a manual review (REV-02), not a gate.
mkdir -p "$work/rules"
for lang in javascript typescript generic/secrets; do
  find "$work/src/$lang" -path '*/security/*' ! -path '*/audit/*' -name '*.yaml' ! -name '*.test.yaml' | while read -r rule; do
    target="$work/rules/${rule#"$work/src/"}"
    mkdir -p "$(dirname "$target")"
    cp "$rule" "$target"
  done
done
echo "Semgrep rules: $(find "$work/rules" -name '*.yaml' | wc -l) files from semgrep-rules@${RULES_COMMIT:0:12}"

semgrep scan --metrics=off --disable-version-check --error --config "$work/rules" \
  --exclude node_modules --exclude dist --exclude .next --exclude public "${@:-.}"
