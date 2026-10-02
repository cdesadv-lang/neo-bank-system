import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma, nextSeq, withTx } from "@/lib/db";
import { AppError, Errors } from "@/lib/errors";
import { audit, type Actor } from "@/server/audit";
import { requirePerm, type StaffPrincipal } from "@/server/rbac";

export async function listAlerts(staff: StaffPrincipal, f: { status?: string } = {}) {
  requirePerm(staff, "aml.read");
  const where: Prisma.AmlAlertWhereInput = {};
  if (f.status) where.status = f.status;
  return prisma.amlAlert.findMany({ where, include: { rule: true, customer: true, case: true }, orderBy: { createdAt: "desc" }, take: 300 });
}

export async function listCases(staff: StaffPrincipal) {
  requirePerm(staff, "aml.read");
  return prisma.amlCase.findMany({ include: { customer: true, alerts: { include: { rule: true } } }, orderBy: { createdAt: "desc" }, take: 200 });
}

export async function getCase(staff: StaffPrincipal, id: string) {
  requirePerm(staff, "aml.read");
  const c = await prisma.amlCase.findUnique({ where: { id }, include: { customer: { include: { accounts: true } }, alerts: { include: { rule: true } } } });
  if (!c) throw Errors.notFound("Case");
  return c;
}

export async function updateAlert(staff: StaffPrincipal, actor: Actor, id: string, raw: unknown) {
  requirePerm(staff, "aml.manage");
  const { status } = z.object({ status: z.enum(["IN_REVIEW", "CLOSED_FALSE_POSITIVE", "ESCALATED"]) }).parse(raw);
  const a = await prisma.amlAlert.findUnique({ where: { id } });
  if (!a) throw Errors.notFound("Alert");
  const after = await prisma.amlAlert.update({ where: { id }, data: { status } });
  await audit(actor, "AML_ALERT_UPDATED", { type: "AmlAlert", id }, { status: a.status }, { status });
  return after;
}

export async function openCase(staff: StaffPrincipal, actor: Actor, raw: unknown) {
  requirePerm(staff, "aml.manage");
  const { alertIds, note } = z.object({ alertIds: z.array(z.string()).min(1), note: z.string().max(1000).optional() }).parse(raw);
  return withTx(async (tx) => {
    const alerts = await tx.amlAlert.findMany({ where: { id: { in: alertIds } } });
    if (alerts.length !== alertIds.length) throw Errors.notFound("Alert");
    const customers = new Set(alerts.map((a) => a.customerId));
    if (customers.size !== 1) throw Errors.validation("All alerts in a case must belong to one customer");
    if (alerts.some((a) => a.caseId)) throw Errors.conflict("Some alerts are already in a case");
    const n = await nextSeq(tx, "nb_case_seq");
    const c = await tx.amlCase.create({
      data: {
        caseNo: `CASE-${String(n).padStart(5, "0")}`, customerId: alerts[0].customerId, openedById: staff.id, assignedToId: staff.id, status: "INVESTIGATING",
        notes: note ? [{ at: new Date().toISOString(), by: staff.username, text: note }] : [],
      },
    });
    await tx.amlAlert.updateMany({ where: { id: { in: alertIds } }, data: { caseId: c.id, status: "ESCALATED" } });
    await audit(actor, "AML_CASE_OPENED", { type: "AmlCase", id: c.id }, undefined, { alerts: alertIds }, tx);
    return c;
  });
}

export async function caseAction(staff: StaffPrincipal, actor: Actor, id: string, raw: unknown) {
  requirePerm(staff, "aml.manage");
  const input = z.object({ action: z.enum(["NOTE", "CLOSE"]), text: z.string().max(2000).optional(), decision: z.enum(["FALSE_POSITIVE", "SAR_FILED", "ACCOUNT_FROZEN"]).optional() }).parse(raw);
  const c = await prisma.amlCase.findUnique({ where: { id } });
  if (!c) throw Errors.notFound("Case");
  if (c.status === "CLOSED") throw new AppError("INVALID_STATE", 409, "Case closed");
  const notes = Array.isArray(c.notes) ? (c.notes as object[]) : [];
  if (input.action === "NOTE") {
    if (!input.text) throw Errors.validation("Note text required");
    const after = await prisma.amlCase.update({ where: { id }, data: { notes: [...notes, { at: new Date().toISOString(), by: staff.username, text: input.text }] } });
    await audit(actor, "AML_CASE_NOTE", { type: "AmlCase", id }, undefined, { text: input.text });
    return after;
  }
  if (!input.decision) throw Errors.validation("Decision required");
  const after = await prisma.amlCase.update({
    where: { id },
    data: { status: "CLOSED", decision: input.decision, closedAt: new Date(), notes: [...notes, { at: new Date().toISOString(), by: staff.username, text: `Closed: ${input.decision}. ${input.text ?? ""}` }] },
  });
  await prisma.amlAlert.updateMany({ where: { caseId: id }, data: { status: input.decision === "FALSE_POSITIVE" ? "CLOSED_FALSE_POSITIVE" : "CLOSED_SAR_FILED" } });
  await audit(actor, "AML_CASE_CLOSED", { type: "AmlCase", id }, { status: c.status }, { status: "CLOSED", decision: input.decision });
  return after;
}
