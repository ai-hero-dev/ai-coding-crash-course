#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
image_name="${DEVCONTAINER_IMAGE:-ai-coding-crash-course-devcontainer}"

docker build \
	-f "${repo_root}/Dockerfile-devcontainer" \
	--build-arg "USER_NAME=${USER}" \
	--build-arg "USER_SHELL=${SHELL:-/bin/bash}" \
	--build-arg "USER_ID=${USER_ID:-$(id -u)}" \
	-t "${image_name}" \
	"${repo_root}"
