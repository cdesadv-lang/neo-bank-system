import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "crypto";

/**
 * HSM adapter. In production this is a certified HSM (e.g. payShield / Luna) reached
 * over its host command interface; PINs only ever exist in clear inside the HSM.
 * This repository ships ONLY a mock that emulates the same contract in software.
 */
export interface HsmAdapter {
  name: string;
  isMock: boolean;
  /** Terminal/PIN-pad side: encrypt a PIN into a PIN block under the zone key (ZPK). */
  encryptPinBlock(pin: string, cardToken: string): string;
  /** Derive the PIN verification value (PVV) to store for a card. */
  generatePvv(cardToken: string, pinBlock: string): string;
  /** Verify a PIN block against a stored PVV. */
  verifyPin(cardToken: string, pinBlock: string, pvv: string): boolean;
}

function key(name: string): Buffer {
  const env = process.env[name];
  if (env && env.length >= 32) return createHash("sha256").update(env).digest();
  if (process.env.NODE_ENV === "production" && process.env.ALLOW_MOCK_HSM !== "1") throw new Error(`${name} must be configured`);
  return createHash("sha256").update(`dev-only-${name}`).digest();
}

/** ISO 9564 format-0 style block: (0 | len | PIN | F…) XOR (0000 | 12 digits derived from the card token). */
function isoFormat0(pin: string, cardToken: string): Buffer {
  if (!/^\d{4,6}$/.test(pin)) throw new Error("PIN must be 4-6 digits");
  const pinField = Buffer.from(`0${pin.length}${pin}`.padEnd(16, "F"), "hex");
  const digits = createHash("sha256").update(cardToken).digest("hex").replace(/[a-f]/g, "").padEnd(12, "0").slice(0, 12);
  const panField = Buffer.from(`0000${digits}`, "hex");
  return Buffer.from(pinField.map((b, i) => b ^ panField[i]));
}

function decodeFormat0(block: Buffer, cardToken: string): string {
  const digits = createHash("sha256").update(cardToken).digest("hex").replace(/[a-f]/g, "").padEnd(12, "0").slice(0, 12);
  const panField = Buffer.from(`0000${digits}`, "hex");
  const clear = Buffer.from(block.map((b, i) => b ^ panField[i])).toString("hex").toUpperCase();
  const len = parseInt(clear[1], 16);
  return clear.slice(2, 2 + len);
}

/** Happens inside the HSM boundary in a real deployment. */
function mockDecrypt(cardToken: string, pinBlock: string): string {
  const raw = Buffer.from(pinBlock, "base64");
  const d = createDecipheriv("aes-256-gcm", key("HSM_MOCK_ZPK"), raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  const block = Buffer.concat([d.update(raw.subarray(28)), d.final()]);
  return decodeFormat0(block, cardToken);
}

export const MockHsm: HsmAdapter = {
  name: "MOCK_HSM",
  isMock: true,
  encryptPinBlock(pin, cardToken) {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", key("HSM_MOCK_ZPK"), iv);
    const ct = Buffer.concat([c.update(isoFormat0(pin, cardToken)), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64");
  },
  generatePvv(cardToken, pinBlock) {
    const pin = mockDecrypt(cardToken, pinBlock);
    return createHmac("sha256", key("HSM_MOCK_PVK")).update(`${cardToken}:${pin}`).digest("hex");
  },
  verifyPin(cardToken, pinBlock, pvv) {
    let candidate: string;
    try {
      candidate = MockHsm.generatePvv(cardToken, pinBlock);
    } catch {
      return false;
    }
    const a = Buffer.from(candidate, "hex");
    const b = Buffer.from(pvv, "hex");
    return a.length === b.length && timingSafeEqual(a, b);
  },
};


export function getHsm(): HsmAdapter {
  return MockHsm;
}
