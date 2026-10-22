#!/usr/bin/env bash
# Live check of login / check / logout (plan-m3.md §3), run by the owner: signs in with .rc-credentials
# (username:password), checks the new token, signs it out, and checks that the token in rc.token (the MCP's own
# session) still works, i.e. logout ends only its own session. Prints no token or password.
#   scripts/test-session.sh            (builds dist/ first)
set -u
cd "$(dirname "$0")/.." || exit 2

CLI=(node dist/main.js)
fails=0
step() { printf '\n== %s\n' "$1"; }
pass() { printf 'PASS: %s\n' "$1"; }
fail() { printf 'FAIL: %s\n' "$1"; fails=$((fails + 1)); }
# expect <description> <wanted exit code> <regex for the output> -- command…
expect() {
  local what=$1 code=$2 re=$3
  shift 4
  local out rc
  out=$("$@" 2>&1)
  rc=$?
  printf '%s\n' "$out" | sed 's/^/  | /'
  if [[ $rc -eq $code && $out =~ $re ]]; then pass "$what"; else fail "$what (exit $rc, wanted $code and /$re/)"; fi
}

[[ -f .rc-credentials ]] || { echo ".rc-credentials not found (username:password)"; exit 2; }
IFS= read -r creds < .rc-credentials
user=${creds%%:*}
pass=${creds#*:}
[[ $creds == *:* && -n $user && -n $pass ]] || { echo ".rc-credentials must be username:password"; exit 2; }
npm run build >/dev/null || { echo "build failed"; exit 2; }
main_token=$(tr -d '[:space:]' < rc.token 2>/dev/null)
token=

# Secrets go through the environment and stdin only, never through command-line arguments (visible in ps).
with_token() { RC_TOKEN=$1 "${CLI[@]}" "${@:2}"; }
main() { with_token "$main_token" "$@"; }
new() { with_token "$token" "$@"; }
no_token() { (unset RC_TOKEN; "${CLI[@]}" "$@"); }
login_with() { printf '%s\n%s\n' "$user" "$1" | "${CLI[@]}" login; }
login_wrong() { login_with "${pass}-wrong"; }

if [[ -n $main_token ]]; then
  step "0. The MCP's own token (rc.token) works before"
  expect "rc.token works" 0 "Token works" -- main check
fi

step "1. A wrong password is refused"
expect "wrong password refused" 1 "Sign-in refused" -- login_wrong

step "2. login prints a new token on stdout (prompts and the note go to stderr)"
token=$(login_with "$pass" 2>/dev/null)
rc=$?
if [[ $rc -eq 0 && -n $token && $token != *$'\n'* ]]; then
  pass "login exit 0, one-line token (${#token} characters)"
else
  fail "login (exit $rc, ${#token} characters on stdout)"
fi

step "3. check with the new token"
expect "new token works" 0 "Token works.*User:.*Agency:.*Access: read" -- new check

step "4. logout ends the new session"
expect "logout" 0 "Signed out" -- new logout

step "5. check with the signed-out token"
expect "signed-out token rejected" 1 "rejected.*401" -- new check

step "6. logout again is harmless"
expect "second logout" 0 "already invalid" -- new logout

if [[ -n $main_token ]]; then
  step "7. The MCP's own token (rc.token) still works after"
  expect "rc.token still works" 0 "Token works" -- main check
else
  printf '\n(no rc.token: skipped steps 0 and 7, the check that logout ends only its own session)\n'
fi

step "8. Without a token"
expect "check without RC_TOKEN" 1 "RC_TOKEN is not set" -- no_token check
expect "logout without RC_TOKEN" 1 "RC_TOKEN is not set" -- no_token logout

printf '\n%s\n' "$([[ $fails -eq 0 ]] && echo 'ALL PASSED' || echo "$fails FAILED")"
exit $((fails > 0))
