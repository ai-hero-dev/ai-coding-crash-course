#!/usr/bin/env bash
set -euo pipefail

workspace_folder=$1

cd "${workspace_folder}" || exit 1

npm install
npm run db:migrate
npm run db:seed
