#!/usr/bin/env bash
set -euo pipefail

workspace_folder=$1
repo_root="$(cd "$(dirname "$0")/.." && pwd)"
user_id="$(id -u)"

mkdir -m 755 -p "${repo_root}/.devcontainer/assets"
{
	echo "USER_ID=${user_id}"
	echo "HOST_OS=$(uname -o)"
} >"${repo_root}/.devcontainer/assets/setup.env"

env_file="${repo_root}/.env"
if [ ! -f "${env_file}" ]; then
	echo "USER_ID=${user_id}" >"${env_file}"
elif ! grep -q '^USER_ID=' "${env_file}"; then
	echo "USER_ID=${user_id}" >>"${env_file}"
fi

git config oh-my-zsh.hide-dirty 1 2>/dev/null || true

git config --global --add safe.directory "${workspace_folder}" || true

if [ ! -f "${HOME}/.zsh_history_devcontainer" ]; then
	touch "${HOME}/.zsh_history_devcontainer"
	if [ -f "${HOME}/.zsh_history" ]; then
		cat "${HOME}/.zsh_history" >>"${HOME}/.zsh_history_devcontainer"
	fi
fi

if [ ! -f "${HOME}/.bash_history_devcontainer" ]; then
	touch "${HOME}/.bash_history_devcontainer"
	if [ -f "${HOME}/.bash_history" ]; then
		cat "${HOME}/.bash_history" >>"${HOME}/.bash_history_devcontainer"
	fi
fi

# Docker Compose 5 cannot build the devcontainer image when the CLI rewrites `build:`.
bash "${repo_root}/.devcontainer/build-devcontainer-image.sh"
