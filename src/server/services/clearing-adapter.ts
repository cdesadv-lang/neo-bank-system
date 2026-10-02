import type { ClearingBatch, Transfer } from "@prisma/client";
import { minorToString } from "@/lib/money";

/**
 * Pluggable clearing adapter. A real deployment would implement this against the
 * national ACH / instant-payment network (e.g. via the central bank's interface).
 */
export interface ClearingAdapter {
  name: string;
  isMock: boolean;
  buildFile(batch: ClearingBatch, items: Transfer[]): string;
  submit(file: string): Promise<{ accepted: boolean; ack: string }>;
}

/** MOCK — no network calls. Produces a CSV "file" and immediately acknowledges it. */
export const MockAchAdapter: ClearingAdapter = {
  name: "MOCK_ACH",
  isMock: true,
  buildFile(batch, items) {
    const header = `# MOCK ACH FILE — NOT A REAL PAYMENT NETWORK\n# batch=${batch.batchNo} currency=${batch.currency} count=${items.length}\nreference,to_bank,to_account,beneficiary,amount,currency`;
    const body = items.map((t) => [t.reference, t.toBankCode, t.toAccountNumber, `"${(t.toName ?? "").replace(/"/g, "'")}"`, minorToString(t.amount), t.currency].join(","));
    return [header, ...body].join("\n");
  },
  async submit() {
    return { accepted: true, ack: `MOCK-ACK-${Date.now()}` };
  },
};

export function getClearingAdapter(): ClearingAdapter {
  return MockAchAdapter;
}
