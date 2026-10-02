#!/usr/bin/env bash
# End-to-end smoke test against a running server with the demo seed loaded.
#   COOKIE_SECURE=false ALLOW_CONSOLE_OTP=1 ALLOW_MOCK_HSM=1 SWITCH_API_KEY=... npx next start -p 3101 > /tmp/neobank-start.log 2>&1 &
#   BASE=http://localhost:3101 SERVER_LOG=/tmp/neobank-start.log SWITCH_API_KEY=... scripts/smoke.sh
set -uo pipefail
BASE="${BASE:-http://localhost:3101}"
LOG="${SERVER_LOG:-/tmp/neobank-start.log}"
PW="${STAFF_PASSWORD:-NeoBank@2026}"
CPW="${CUSTOMER_PASSWORD:-Portal@2026}"
J=/tmp/nb-smoke; mkdir -p "$J"; rm -f "$J"/*
pass=0; fail=0
ok() { echo "  PASS $1"; pass=$((pass+1)); }
ko() { echo "  FAIL $1"; fail=$((fail+1)); }
code() { curl -s -o "$J/body" -w '%{http_code}' "$@"; }
expect() { local want="$1" name="$2"; shift 2; local got; got=$(code "$@"); [[ "$got" == "$want" ]] && ok "$name ($got)" || { ko "$name (got $got, want $want): $(head -c 200 "$J/body")"; }; }

echo "== health"; expect 200 "GET /api/health" "$BASE/api/health"
echo "== staff logins (every role)"
for u in admin mgr.cairo teller.cairo cs.cairo credit.cairo credit.manager compliance ops finance auditor; do
  expect 200 "login $u" -c "$J/$u.jar" -H 'content-type: application/json' -d "{\"username\":\"$u\",\"password\":\"$PW\"}" "$BASE/api/staff/auth/login"
done
expect 401 "wrong password rejected" -H 'content-type: application/json' -d '{"username":"ops","password":"nope-nope"}' "$BASE/api/staff/auth/login"
echo "== staff APIs & RBAC"
expect 200 "admin customers" -b "$J/admin.jar" "$BASE/api/staff/customers"
expect 200 "finance trial balance" -b "$J/finance.jar" "$BASE/api/staff/reports/trial-balance"
expect 200 "finance balance sheet" -b "$J/finance.jar" "$BASE/api/staff/reports/balance-sheet"
expect 200 "auditor audit log" -b "$J/auditor.jar" "$BASE/api/staff/audit"
expect 200 "compliance AML alerts" -b "$J/compliance.jar" "$BASE/api/staff/aml/alerts"
expect 200 "ops ATMs" -b "$J/ops.jar" "$BASE/api/staff/atms"
expect 200 "ops card auths" -b "$J/ops.jar" "$BASE/api/staff/card-auths"
expect 200 "ops disputes" -b "$J/ops.jar" "$BASE/api/staff/disputes"
expect 200 "credit loans" -b "$J/credit.manager.jar" "$BASE/api/staff/loans"
expect 200 "teller tills" -b "$J/teller.cairo.jar" "$BASE/api/staff/tills"
expect 200 "manager approvals" -b "$J/mgr.cairo.jar" "$BASE/api/staff/approvals"
expect 403 "teller cannot post manual journal" -b "$J/teller.cairo.jar" -H 'content-type: application/json' -d '{}' "$BASE/api/staff/journals/manual"
expect 403 "teller cannot read audit" -b "$J/teller.cairo.jar" "$BASE/api/staff/audit"
expect 403 "auditor cannot create staff" -b "$J/auditor.jar" -H 'content-type: application/json' -d '{}' "$BASE/api/staff/staff"
expect 401 "no session" "$BASE/api/staff/customers"
echo "== staff pages"
for p in /staff /staff/customers /staff/accounts /staff/teller /staff/tills /staff/transfers /staff/loans /staff/deposits /staff/cards /staff/card-auths /staff/atms /staff/disputes /staff/devices /staff/aml /staff/approvals /staff/journals /staff/reports /staff/reports/balance-sheet /staff/eod /staff/tickets /staff/admin /staff/audit /staff/security; do
  expect 200 "page $p" -b "$J/admin.jar" "$BASE$p"
done
expect 307 "page /staff without session redirects" "$BASE/staff"
echo "== customer portal (password + OTP)"
curl -s -c "$J/cust.jar" -H 'content-type: application/json' -d "{\"username\":\"ahmed.hassan\",\"password\":\"$CPW\"}" "$BASE/api/portal/auth/login" > "$J/start.json"
CH=$(node -e "const j=require('$J/start.json');process.stdout.write(j.challengeId||'')")
sleep 1
OTP=$(grep -o 'LOGIN code for [^:]*: [0-9]\{6\}' "$LOG" | tail -1 | grep -o '[0-9]\{6\}$')
[[ -n "$CH" && -n "$OTP" ]] && ok "OTP challenge issued" || ko "OTP challenge: $(cat "$J/start.json")"
expect 200 "OTP verify" -c "$J/cust.jar" -H 'content-type: application/json' -d "{\"username\":\"ahmed.hassan\",\"challengeId\":\"$CH\",\"code\":\"$OTP\"}" "$BASE/api/portal/auth/verify"
expect 401 "OTP is single-use" -H 'content-type: application/json' -d "{\"username\":\"ahmed.hassan\",\"challengeId\":\"$CH\",\"code\":\"$OTP\"}" "$BASE/api/portal/auth/verify"
expect 200 "portal accounts" -b "$J/cust.jar" "$BASE/api/portal/accounts"
expect 200 "portal cards" -b "$J/cust.jar" "$BASE/api/portal/cards"
expect 200 "portal notifications" -b "$J/cust.jar" "$BASE/api/portal/notifications"
OTHER=$(psql "${DATABASE_URL%%\?*}" -Atc "select a.id from \"Account\" a join \"Customer\" c on c.id=a.\"customerId\" where c.\"nameEn\"='Mona Ali Ibrahim' limit 1" 2>/dev/null)
[[ -n "$OTHER" ]] && expect 404 "customer isolation (other customer's account)" -b "$J/cust.jar" "$BASE/api/portal/accounts/$OTHER"
for p in /portal /portal/transfers /portal/cards /portal/loans /portal/deposits /portal/bills /portal/notifications /portal/tickets /portal/profile; do
  expect 200 "page $p" -b "$J/cust.jar" "$BASE$p"
done
echo "== ISO 8583 switch endpoint"
expect 401 "switch without key" -H 'content-type: application/json' -d '{"mti":"0100","fields":{}}' "$BASE/api/switch/iso8583"
TOKEN=$(psql "${DATABASE_URL%%\?*}" -Atc "select token from \"Card\" where status='ACTIVE' and \"contactlessEnabled\" limit 1" 2>/dev/null)
if [[ -n "$TOKEN" ]]; then
  STAN=$(printf '%06d' $((RANDOM*10 % 1000000)))
  BODY="{\"mti\":\"0100\",\"fields\":{\"2\":\"$TOKEN\",\"3\":\"000000\",\"4\":\"000000004500\",\"11\":\"$STAN\",\"18\":\"5814\",\"22\":\"071\",\"32\":\"NEOBANK\",\"42\":\"MERSMOKE01\",\"43\":\"Smoke Cafe/CAIRO/EG\",\"49\":\"818\"}}"
  expect 200 "contactless auth via switch" -H 'content-type: application/json' -H "x-switch-key: ${SWITCH_API_KEY:-dev-switch-key-change-me}" -d "$BODY" "$BASE/api/switch/iso8583"
  grep -q '"39":"00"' "$J/body" && ok "approved (DE39=00)" || ko "switch response: $(head -c 300 "$J/body")"
fi
echo
echo "smoke: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
