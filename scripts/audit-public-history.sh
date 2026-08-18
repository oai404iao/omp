#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
cd "$root"

if [[ "$(git branch --show-current)" != "main" ]]; then
  echo "Run the publication audit from the main branch." >&2
  exit 1
fi
if [[ -n "$(git status --porcelain)" ]]; then
  echo "Run the publication audit from a clean checkout." >&2
  exit 1
fi

echo "== Repository integrity =="
git fetch origin --prune --tags
git fsck --full --no-progress
git merge-base --is-ancestor origin/main main
echo "origin/main is an ancestor of main"

echo
echo "== History summary =="
echo "commits: $(git rev-list --count --all)"
echo "non-merge commits: $(git rev-list --count --no-merges --all)"
echo "distinct author identities: $(git log --all --format='%aN <%aE>' | sort -u | wc -l)"
echo "origin/main...main: $(git rev-list --left-right --count origin/main...main)"

echo
echo "== Public-path markers =="
if git grep -n -I -E '/home/u/|ssh://git@gitea|gitea/local' -- \
  ':!scripts/audit-public-history.sh' \
  ':!**/node_modules/**'; then
  echo "Private path or forge markers require review." >&2
  exit 1
else
  echo "No known private path or forge markers in the current tree."
fi

echo
echo "== Secret scan =="
if ! command -v gitleaks >/dev/null 2>&1; then
  echo "gitleaks is required for the full-history audit." >&2
  exit 2
fi
gitleaks git --redact --no-banner --no-color --log-level warn .
gitleaks dir --redact --no-banner --no-color --log-level warn .
echo "No findings from the default gitleaks rules in history or the current tree."

echo
echo "Audit completed. This is evidence for review, not proof that publication is risk-free."
