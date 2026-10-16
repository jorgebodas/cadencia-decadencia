#!/usr/bin/env bash
# Commits changes to the route database made by a workflow and pushes them to the current branch.
# Loop safety: pushes made with the workflow's GITHUB_TOKEN never trigger other workflow runs,
# every workflow also skips runs started by github-actions[bot], and the scripts are idempotent
# (an empty inbox or an unchanged database produces no commit).
set -euo pipefail

message="$1"
branch="${GITHUB_REF_NAME:-main}"

git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git add -A data imports

if git diff --cached --quiet; then
  echo "No changes to commit."
  echo "pushed=false" >> "${GITHUB_OUTPUT:-/dev/null}"
  exit 0
fi

git commit -m "$message"
for attempt in 1 2 3 4; do
  if git pull --rebase origin "$branch" && git push origin "HEAD:$branch"; then
    echo "pushed=true" >> "${GITHUB_OUTPUT:-/dev/null}"
    exit 0
  fi
  sleep $((2 ** attempt))
done
echo "::error::Could not push the route database after 4 attempts"
exit 1
