#!/usr/bin/env bash
# Open a conversation for a member, in Maurice's voice — by hand, through the
# running server, so the member's app is told the way it will be when the
# night does it (services/openedConversations.ts, P2-A of the domains plan).
#
#   scripts/open-conversation.sh <username> "<text>" [--title "…"] [--maurice <domain id>] [--force] [--dry-run]
#   scripts/open-conversation.sh candide "Bonjour Candide, j'ai relu nos conversations…" --title "Trois domaines"
#
# Talks to the API at MAURICE_URL (default http://127.0.0.1:3001) as the
# household admin: MAURICE_ADMIN_USER (default "admin") and
# MAURICE_ADMIN_PASSWORD, asked for when unset. --force skips the guard
# (never for a child or a guest, never twice within the household's number of
# days); --dry-run only prints the guard's verdict for the member.
set -euo pipefail

usage() { sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

[[ $# -ge 1 ]] || usage 1
USERNAME="$1"; shift
TEXT=""; TITLE=""; MAURICE=""; FORCE=false; DRY=false
if [[ $# -ge 1 && "$1" != --* ]]; then TEXT="$1"; shift; fi
while [[ $# -gt 0 ]]; do
  case "$1" in
    --title) TITLE="$2"; shift 2 ;;
    --maurice) MAURICE="$2"; shift 2 ;;
    --force) FORCE=true; shift ;;
    --dry-run) DRY=true; shift ;;
    -h|--help) usage 0 ;;
    *) echo "unknown option: $1" >&2; usage 1 ;;
  esac
done
if [[ "$DRY" == false && -z "$TEXT" ]]; then echo "text required (or --dry-run)" >&2; usage 1; fi

URL="${MAURICE_URL:-http://127.0.0.1:3001}"
ADMIN_USER="${MAURICE_ADMIN_USER:-admin}"
if [[ -z "${MAURICE_ADMIN_PASSWORD:-}" ]]; then
  read -r -s -p "Password for $ADMIN_USER: " MAURICE_ADMIN_PASSWORD; echo
fi
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }

TOKEN="$(curl -sS -X POST "$URL/api/auth/login" -H 'Content-Type: application/json' \
  -d "$(jq -cn --arg u "$ADMIN_USER" --arg p "$MAURICE_ADMIN_PASSWORD" '{username:$u,password:$p}')" | jq -r '.token // empty')"
[[ -n "$TOKEN" ]] || { echo "login failed for $ADMIN_USER at $URL" >&2; exit 1; }

BODY="$(jq -cn --arg username "$USERNAME" --arg text "$TEXT" --arg title "$TITLE" --arg maurice "$MAURICE" \
  --argjson force "$FORCE" --argjson dry "$DRY" \
  '{username:$username, text:$text, force:$force, dry_run:$dry}
   + (if $title != "" then {title:$title} else {} end)
   + (if $maurice != "" then {maurice_id:$maurice} else {} end)')"

RESP="$(curl -sS -w '\n%{http_code}' -X POST "$URL/api/admin/conversations/open" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "$BODY")"
CODE="${RESP##*$'\n'}"; JSON="${RESP%$'\n'*}"
echo "$JSON" | jq .
case "$CODE" in
  200|201) exit 0 ;;
  409) echo "refused by the guard (HTTP 409) — pass --force to open it anyway" >&2; exit 2 ;;
  *) echo "HTTP $CODE" >&2; exit 1 ;;
esac
