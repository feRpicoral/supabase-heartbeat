#!/usr/bin/env bash
set -euo pipefail

CONFIG_FILE="${1:-projects.urls}"
SECRET_VALUE=""
PROJECT_COUNT=0
SECRET_NAME="SUPABASE_DATABASE_URLS"

if [[ "${CONFIG_FILE}" == "-h" || "${CONFIG_FILE}" == "--help" ]]; then
  echo "usage: scripts/sync-gh-secret.sh [url-list-file]"
  echo
  echo "Reads one PostgreSQL URL per non-empty line and stores them in the"
  echo "SUPABASE_DATABASE_URLS GitHub Actions secret."
  echo
  echo "Set GH_REPO=owner/repo to target a repository other than the current one."
  exit 0
fi

if [[ ! -f "${CONFIG_FILE}" ]]; then
  echo "missing config file: ${CONFIG_FILE}" >&2
  exit 1
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "gh CLI is required" >&2
  exit 1
fi

LINE_NUMBER=0
while IFS= read -r LINE || [[ -n "${LINE}" ]]; do
  LINE_NUMBER=$((LINE_NUMBER + 1))

  if [[ -z "${LINE}" ]]; then
    continue
  fi

  case "${LINE}" in
    postgres://*|postgresql://*) ;;
    *)
      echo "invalid line ${LINE_NUMBER}: expected a PostgreSQL URL" >&2
      exit 1
      ;;
  esac

  case "${LINE}" in
    *:6543|*:6543/*|*:6543\?*)
      echo "warning: line ${LINE_NUMBER} looks like a transaction pooler URL; prefer the session pooler on port 5432" >&2
      ;;
  esac

  if [[ "${PROJECT_COUNT}" -eq 0 ]]; then
    SECRET_VALUE="${LINE}"
  else
    SECRET_VALUE="${SECRET_VALUE}"$'\n'"${LINE}"
  fi

  PROJECT_COUNT=$((PROJECT_COUNT + 1))
done < "${CONFIG_FILE}"

if [[ "${PROJECT_COUNT}" -eq 0 ]]; then
  echo "no PostgreSQL URLs found in ${CONFIG_FILE}" >&2
  exit 1
fi

if [[ -n "${GH_REPO:-}" ]]; then
  printf '%s\n' "${SECRET_VALUE}" | gh secret set "${SECRET_NAME}" --app actions --repo "${GH_REPO}"
else
  printf '%s\n' "${SECRET_VALUE}" | gh secret set "${SECRET_NAME}" --app actions
fi

echo "updated ${SECRET_NAME} with ${PROJECT_COUNT} PostgreSQL URL(s)"
