import { createHash } from "crypto";

/**
 * MOCK biller aggregator. In production this would integrate with a licensed
 * bill-payment aggregator. Every biller here is fictional and labelled MOCK.
 */
export type Biller = { code: string; nameAr: string; nameEn: string; category: string; refLabel: string };

export const MOCK_BILLERS: Biller[] = [
  { code: "MOCK-ELEC", nameAr: "شركة الكهرباء التجريبية (تجريبي)", nameEn: "Demo Electricity Co. (MOCK)", category: "UTILITIES", refLabel: "Meter number" },
  { code: "MOCK-WATER", nameAr: "شركة المياه التجريبية (تجريبي)", nameEn: "Demo Water Co. (MOCK)", category: "UTILITIES", refLabel: "Subscriber number" },
  { code: "MOCK-GAS", nameAr: "شركة الغاز التجريبية (تجريبي)", nameEn: "Demo Gas Co. (MOCK)", category: "UTILITIES", refLabel: "Customer number" },
  { code: "MOCK-MOBILE", nameAr: "شبكة المحمول التجريبية (تجريبي)", nameEn: "Demo Mobile Network (MOCK)", category: "TELECOM", refLabel: "Mobile number" },
  { code: "MOCK-NET", nameAr: "مزود الإنترنت التجريبي (تجريبي)", nameEn: "Demo Internet ISP (MOCK)", category: "TELECOM", refLabel: "Landline number" },
];

export const MockBillerAdapter = {
  name: "MOCK_BILLERS",
  isMock: true,
  list: () => MOCK_BILLERS,
  /** Deterministic fake "amount due" (EGP 50–1,049) derived from the reference. */
  inquire(code: string, reference: string): { amountDue: bigint } | null {
    if (!MOCK_BILLERS.find((b) => b.code === code)) return null;
    if (!/^[0-9A-Za-z-]{4,20}$/.test(reference)) return null;
    const h = createHash("sha256").update(`${code}:${reference}`).digest();
    return { amountDue: BigInt(5000 + (h.readUInt32BE(0) % 100000)) };
  },
  async pay(code: string, reference: string, amount: bigint) {
    return { ok: true, receipt: `MOCK-RCPT-${code}-${reference}-${amount}` };
  },
};
