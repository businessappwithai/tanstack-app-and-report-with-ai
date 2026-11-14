#!/usr/bin/env bash
#
# Prove the chat assistant works against the real stack: sign in with an
# application account, open a page in each product through a single-use
# ticket, and see that nothing it says to the browser is an address.
#
# It needs no language model: everything here is the assistant's own HTTP
# surface, which is where identity, tickets and the reporting delegation live.
#
#   ORIGIN=http://localhost bash common/build/chat-smoke.sh
#   CHAT_EMAIL=admin@admin.com CHAT_PASSWORD=administrator  (the defaults)
#   CHAT_ENTITY=bus_account                          (skip asking the application for one)
set -uo pipefail

ORIGIN="${ORIGIN:-http://localhost}"
CHAT="$ORIGIN/chat"
EMAIL="${CHAT_EMAIL:-admin@admin.com}"
PASSWORD="${CHAT_PASSWORD:-administrator}"
JAR="$(mktemp)"
trap 'rm -f "$JAR"' EXIT
FAILED=0

ok()   { printf '  ok    %s\n' "$1"; }
fail() { printf '  FAIL  %s\n' "$1"; FAILED=$((FAILED + 1)); }
check() { # label, condition-exit-status
  if [[ "$2" == "0" ]]; then ok "$1"; else fail "$1"; fi
}

status() { curl -s -o /dev/null -w '%{http_code}' --max-time 30 "$@"; }

echo "Without a session"
check "/chat/healthz answers"                         "$([[ $(status "$CHAT/healthz") == 200 ]]; echo $?)"
check "/chat/api/session refuses a stranger (401)"    "$([[ $(status "$CHAT/api/session") == 401 ]]; echo $?)"
check "/chat/open/<unknown ticket> is not available"  "$([[ $(status "$CHAT/open/not-a-ticket") == 404 ]]; echo $?)"

echo
echo "Signing in with the application's own account ($EMAIL)"
# The application seeds its accounts after it starts answering, so a first sign-in can be refused
# for being early rather than for being wrong. Try for up to SIGNIN_WAIT seconds, and say what came back.
deadline=$((SECONDS + ${SIGNIN_WAIT:-300}))
while :; do
  code=$(curl -s -o /tmp/chat-signin.body -w '%{http_code}' --max-time 30 -c "$JAR" \
    -H "origin: $ORIGIN" -H 'content-type: application/json' \
    -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" "$CHAT/api/auth/sign-in/email")
  [[ $code == 200 || $SECONDS -ge $deadline ]] && break
  sleep 5
done
[[ $code == 200 ]] || { echo "        last answer: $code $(head -c 300 /tmp/chat-signin.body 2>/dev/null)"; }
check "the application accepted the sign-in through /chat ($code)" "$([[ $code == 200 ]]; echo $?)"

session=$(curl -s --max-time 30 -b "$JAR" "$CHAT/api/session")
echo "$session" | jq -e --arg e "$EMAIL" '.user.email == $e' >/dev/null 2>&1
check "the session is that account" "$?"
echo "$session" | jq -e '.enabled == true' >/dev/null 2>&1
check "the assistant is switched on" "$?"

echo
echo "The administrator's switches are relayed to the reporting platform"
sw=$(curl -s --max-time 30 "$CHAT/switches")
echo "$sw" | jq -e '.known == true' >/dev/null 2>&1
check "/chat/switches is known and public" "$?"
echo "$sw" | jq -e 'keys | sort == ["chatOnly","enabled","known"]' >/dev/null 2>&1
check "…and says nothing but the two switches" "$?"

echo
echo "Tickets"
ticket_for() { # json intent -> ticket on stdout
  curl -s --max-time 60 -b "$JAR" -H 'content-type: application/json' -d "$1" "$CHAT/api/tickets" | jq -r '.ticket // empty'
}
open_status() { curl -s -o /dev/null -D - --max-time 60 -b "$JAR" "$CHAT/open/$1"; }

# The administrator reads every table, so the first business entity the application lists is openable.
entity="${CHAT_ENTITY:-$(curl -s --max-time 30 -b "$JAR" -H "origin: $ORIGIN" "$ORIGIN/api/sys/tables?prefix=bus_&limit=1" \
  | jq -r '(.data // .)[0].table_name // empty')}"
if [[ -n "$entity" ]]; then
  t=$(ticket_for "{\"product\":\"app\",\"kind\":\"page\",\"object\":\"$entity\",\"title\":\"smoke\"}")
  [[ -n "$t" ]]; check "a ticket for the application's page $entity" "$?"
  headers=$(open_status "$t")
  echo "$headers" | grep -qi '^HTTP/[0-9.]* 302'; check "redeeming it redirects the frame" "$?"
  echo "$headers" | grep -qi '^set-cookie: chat_embed='; check "…and marks the frame as the assistant's" "$?"
  headers=$(open_status "$t")
  echo "$headers" | grep -qi '^HTTP/[0-9.]* 404'; check "the same ticket does not work twice" "$?"
else
  fail "the application listed no business entity to open"
fi

t=$(ticket_for '{"product":"report","kind":"page","object":"home","title":"smoke"}')
[[ -n "$t" ]]; check "a ticket for the reporting platform (it signed this person in by delegation)" "$?"
headers=$(open_status "$t")
echo "$headers" | grep -qi '^HTTP/[0-9.]* 302'; check "redeeming it redirects the frame" "$?"
echo "$headers" | grep -qi '^set-cookie: .*session_token='; check "…and carries the reporting platform's own session" "$?"

echo
echo "The browser is never handed an address it could guess"
body=$(curl -s --max-time 30 -b "$JAR" -H 'content-type: application/json' \
  -d '{"product":"app","kind":"page","object":"../admin/secrets","title":"x"}' "$CHAT/api/tickets")
echo "$body" | jq -e '.ticket == null' >/dev/null 2>&1
check "an intent that carries a path is refused" "$?"

echo
if [[ $FAILED -eq 0 ]]; then
  echo "chat assistant: all checks passed"
else
  echo "chat assistant: $FAILED check(s) failed"
  exit 1
fi
