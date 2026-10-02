/**
 * IBAN-style account numbers following the Egyptian IBAN layout (29 chars):
 *   EG kk BBBB SSSS AAAAAAAAAAAAAAAAA
 *   kk   = ISO 13616 mod-97 check digits
 *   BBBB = bank code (Neo Bank fictional code 0099)
 *   SSSS = branch code
 *   A..  = 17-digit account number
 * The bank code is fictional; these numbers are not routable on any real network.
 */
export const BANK_CODE = "0099";
export const BANK_NAME_EN = "Neo Bank (Demo)";

function mod97(numeric: string): number {
  let rem = 0;
  for (let i = 0; i < numeric.length; i += 7) {
    rem = Number(String(rem) + numeric.slice(i, i + 7)) % 97;
  }
  return rem;
}

function toNumeric(s: string): string {
  return s
    .toUpperCase()
    .split("")
    .map((ch) => (/[A-Z]/.test(ch) ? String(ch.charCodeAt(0) - 55) : ch))
    .join("");
}

export function makeIban(branchCode: string, accountSerial: bigint | number, country = "EG", bankCode = BANK_CODE): string {
  const bban = `${bankCode}${branchCode.padStart(4, "0")}${String(accountSerial).padStart(17, "0")}`;
  const check = 98 - mod97(toNumeric(`${bban}${country}00`));
  return `${country}${String(check).padStart(2, "0")}${bban}`;
}

export function isValidIban(iban: string): boolean {
  const s = iban.replace(/\s+/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(s)) return false;
  if (s.startsWith("EG") && s.length !== 29) return false;
  return mod97(toNumeric(s.slice(4) + s.slice(0, 4))) === 1;
}

export function bankCodeOf(iban: string): string {
  return iban.replace(/\s+/g, "").slice(4, 8);
}

export function formatIban(iban: string): string {
  return iban.replace(/(.{4})/g, "$1 ").trim();
}
