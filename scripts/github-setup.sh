#!/usr/bin/env bash
# One-time GitHub setup for the public Hoku repository: the issue labels the issue forms
# apply, and private vulnerability reporting (which SECURITY.md points reporters to).
#
#   ./scripts/github-setup.sh --dry-run            print what would change
#   ./scripts/github-setup.sh                      apply to joao-afonso-p/hoku
#   ./scripts/github-setup.sh owner/repo           apply to another repository
#
# Run it after the repository is public: private vulnerability reporting is only offered
# for public repositories. Needs the GitHub CLI (`gh auth login`) with admin rights on the
# repository. Safe to re-run: labels are created or updated, and enabling reporting twice
# is a no-op.
set -euo pipefail

repo="joao-afonso-p/hoku"
dry_run=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) dry_run=1 ;;
    -h | --help) sed -n '2,12p' "$0"; exit 0 ;;
    -*) echo "Unknown option: $arg" >&2; exit 2 ;;
    *) repo="$arg" ;;
  esac
done

run() {
  if [ "$dry_run" = 1 ]; then
    printf 'would run:'; printf ' %q' "$@"; printf '\n'
  else
    "$@"
  fi
}

command -v gh >/dev/null || { echo "The GitHub CLI (gh) is required." >&2; exit 1; }
if [ "$dry_run" = 0 ]; then
  gh auth status >/dev/null 2>&1 || { echo "Run 'gh auth login' first." >&2; exit 1; }
  visibility="$(gh repo view "$repo" --json visibility --jq .visibility)"
  [ "$visibility" = "PUBLIC" ] || {
    echo "$repo is $visibility. Make it public first; private vulnerability reporting needs a public repository." >&2
    exit 1
  }
fi

# Labels used by .github/ISSUE_TEMPLATE/*.yml, plus the one Dependabot applies.
#       name           color    description
labels=(
  "bug|d73a4a|Something isn't working"
  "provider|1d76db|New provider or change to a provider integration"
  "platform|5319e7|Platform support beyond macOS (Linux, Windows)"
  "dependencies|0366d6|Dependency updates"
)
for entry in "${labels[@]}"; do
  IFS='|' read -r name color description <<<"$entry"
  run gh label create "$name" --repo "$repo" --color "$color" --description "$description" --force
done

run gh api --method PUT "repos/$repo/private-vulnerability-reporting" --silent

if [ "$dry_run" = 0 ]; then
  enabled="$(gh api "repos/$repo/private-vulnerability-reporting" --jq .enabled)"
  [ "$enabled" = "true" ] || { echo "Private vulnerability reporting is not enabled on $repo." >&2; exit 1; }
  echo "Labels set and private vulnerability reporting enabled on $repo."
fi
