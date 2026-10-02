import type { Account, JournalEntry } from "@prisma/client";
import { Tx, nextSeq } from "@/lib/db";
import { toEgpEquivalent } from "@/lib/fx";
import { minorToString } from "@/lib/money";

const AML_TYPES = ["CASH_DEPOSIT", "CASH_WITHDRAWAL", "TRANSFER", "EXTERNAL_TRANSFER", "BILL_PAYMENT"];

type Touched = { account: Account; debit: bigint; credit: bigint };

/**
 * Rule-based transaction monitoring, executed inside the posting transaction so
 * an alert exists iff the movement exists.
 *  SINGLE_AMOUNT      single movement >= threshold (EGP equivalent)
 *  CASH_AMOUNT        cash deposit/withdrawal >= threshold (CTR-style)
 *  VELOCITY_COUNT     >= threshold movements within windowMinutes
 *  VELOCITY_AMOUNT    sum of movements within windowMinutes >= threshold
 *  HIGH_RISK_CUSTOMER movement by HIGH risk customer >= threshold
 */
export async function evaluateAml(tx: Tx, entry: JournalEntry, touched: Touched[]) {
  if (!touched.length) return;
  const rules = await tx.amlRule.findMany({ where: { active: true } });
  if (!rules.length) return;

  const byCustomer = new Map<string, Touched[]>();
  for (const t of touched) {
    const arr = byCustomer.get(t.account.customerId) ?? [];
    arr.push(t);
    byCustomer.set(t.account.customerId, arr);
  }

  for (const [customerId, items] of byCustomer) {
    const customer = await tx.customer.findUnique({ where: { id: customerId }, select: { riskRating: true } });
    const amount = items.reduce((s, i) => s + i.debit + i.credit, 0n);
    const egp = toEgpEquivalent(amount, entry.currency);
    const accountId = items[0].account.id;

    for (const rule of rules) {
      let hit = false;
      let details = "";
      if (rule.kind === "SINGLE_AMOUNT" && egp >= rule.threshold) {
        hit = true;
        details = `Single movement ${minorToString(amount)} ${entry.currency} (≈ EGP ${minorToString(egp)}) ≥ ${minorToString(rule.threshold)}`;
      } else if (rule.kind === "CASH_AMOUNT" && (entry.type === "CASH_DEPOSIT" || entry.type === "CASH_WITHDRAWAL") && egp >= rule.threshold) {
        hit = true;
        details = `Cash ${entry.type === "CASH_DEPOSIT" ? "deposit" : "withdrawal"} ≈ EGP ${minorToString(egp)} ≥ ${minorToString(rule.threshold)}`;
      } else if (rule.kind === "HIGH_RISK_CUSTOMER" && customer?.riskRating === "HIGH" && egp >= rule.threshold) {
        hit = true;
        details = `High-risk customer movement ≈ EGP ${minorToString(egp)}`;
      } else if (rule.kind === "VELOCITY_COUNT" || rule.kind === "VELOCITY_AMOUNT") {
        const since = new Date(entry.postedAt.getTime() - rule.windowMinutes * 60_000);
        const rows = await tx.$queryRaw<{ currency: string; cnt: bigint; total: bigint }[]>`
          SELECT l.currency::text AS currency, COUNT(DISTINCT e.id)::bigint AS cnt, COALESCE(SUM(l.debit + l.credit),0)::bigint AS total
          FROM "JournalLine" l JOIN "JournalEntry" e ON e.id = l."entryId" JOIN "Account" a ON a.id = l."accountId"
          WHERE a."customerId" = ${customerId} AND e."postedAt" > ${since} AND e."postedAt" <= ${entry.postedAt}
            AND e.type = ANY(${AML_TYPES}::text[]) AND e.status = 'POSTED'
          GROUP BY l.currency`;
        const cnt = rows.reduce((s, r) => s + Number(r.cnt), 0);
        const totalEgp = rows.reduce((s, r) => s + toEgpEquivalent(BigInt(r.total), r.currency), 0n);
        if (rule.kind === "VELOCITY_COUNT" && BigInt(cnt) >= rule.threshold) {
          hit = true;
          details = `${cnt} movements within ${rule.windowMinutes} min (threshold ${rule.threshold})`;
        }
        if (rule.kind === "VELOCITY_AMOUNT" && totalEgp >= rule.threshold) {
          hit = true;
          details = `≈ EGP ${minorToString(totalEgp)} moved within ${rule.windowMinutes} min (threshold ${minorToString(rule.threshold)})`;
        }
        if (hit) {
          // De-duplicate velocity alerts: one open alert per rule/customer per window.
          const dup = await tx.amlAlert.findFirst({
            where: { ruleId: rule.id, customerId, status: { in: ["OPEN", "IN_REVIEW"] }, createdAt: { gt: since } },
          });
          if (dup) hit = false;
        }
      }
      if (hit) {
        const n = await nextSeq(tx, "nb_alert_seq");
        await tx.amlAlert.create({
          data: {
            alertNo: `AML-${String(n).padStart(6, "0")}`,
            ruleId: rule.id,
            customerId,
            accountId,
            journalEntryId: entry.id,
            amount,
            currency: entry.currency,
            details,
            severity: rule.severity,
            createdAt: entry.postedAt,
          },
        });
      }
    }
  }
}
