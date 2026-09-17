#!/usr/bin/env bash
# Writes the source checkout's identity into the built app without touching tracked files.
set -euo pipefail

repo_root="$(cd "${SRCROOT}/../.." && pwd)"
resources_dir="${TARGET_BUILD_DIR}/${UNLOCALIZED_RESOURCES_FOLDER_PATH}"
output="${resources_dir}/BuildMetadata.plist"
source_commit="${CUBBY_SOURCE_COMMIT:-HEAD}"

commit="$(git -C "$repo_root" rev-parse --short=7 "$source_commit")"
subject="$(git -C "$repo_root" show -s --format=%s "$source_commit")"
branch="${CUBBY_SOURCE_BRANCH:-$(git -C "$repo_root" symbolic-ref --short -q HEAD || true)}"
if [[ -z "$branch" ]]; then branch="detached HEAD"; fi

mkdir -p "$resources_dir"
plutil -create xml1 "$output"
plutil -insert branch -string "$branch" "$output"
plutil -insert commit -string "$commit" "$output"
plutil -insert subject -string "$subject" "$output"
