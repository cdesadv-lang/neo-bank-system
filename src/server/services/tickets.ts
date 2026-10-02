import { z } from "zod";
import { prisma, nextSeq } from "@/lib/db";
import { Errors } from "@/lib/errors";
import { audit, type Actor } from "@/server/audit";
import { branchWhere, requirePerm, type StaffPrincipal, assertBranchAccess } from "@/server/rbac";
import { notify } from "./notify";

export const ticketInput = z.object({ subject: z.string().min(3).max(140), category: z.enum(["GENERAL", "CARDS", "TRANSFERS", "LOANS", "ACCOUNTS", "COMPLAINT"]).default("GENERAL"), body: z.string().min(3).max(4000) });

export async function createTicket(customerId: string, authorName: string, actor: Actor, raw: unknown, createdAt?: Date) {
  const input = ticketInput.parse(raw);
  const n = await nextSeq(prisma, "nb_ticket_seq");
  const t = await prisma.supportTicket.create({
    data: {
      ticketNo: `TCK-${n}`, customerId, subject: input.subject, category: input.category, createdAt,
      messages: { create: { authorType: "CUSTOMER", authorId: customerId, authorName, body: input.body, createdAt } },
    },
  });
  await audit(actor, "TICKET_CREATED", { type: "SupportTicket", id: t.id }, undefined, { subject: t.subject });
  return t;
}

export async function customerReply(customerId: string, authorName: string, ticketId: string, raw: unknown) {
  const { body } = z.object({ body: z.string().min(1).max(4000) }).parse(raw);
  const t = await prisma.supportTicket.findUnique({ where: { id: ticketId } });
  if (!t || t.customerId !== customerId) throw Errors.notFound("Ticket");
  await prisma.ticketMessage.create({ data: { ticketId, authorType: "CUSTOMER", authorId: customerId, authorName, body } });
  return prisma.supportTicket.update({ where: { id: ticketId }, data: { status: t.status === "RESOLVED" ? "OPEN" : t.status } });
}

export async function listTicketsStaff(staff: StaffPrincipal, status?: string) {
  requirePerm(staff, "ticket.read");
  return prisma.supportTicket.findMany({
    where: { ...(status ? { status } : {}), customer: { ...branchWhere(staff) } },
    include: { customer: true, messages: { orderBy: { createdAt: "asc" } } },
    orderBy: { updatedAt: "desc" },
    take: 200,
  });
}

export async function staffTicketAction(staff: StaffPrincipal, actor: Actor, ticketId: string, raw: unknown) {
  requirePerm(staff, "ticket.manage");
  const input = z.object({ body: z.string().max(4000).optional(), status: z.enum(["OPEN", "IN_PROGRESS", "RESOLVED", "CLOSED"]).optional(), assignToMe: z.boolean().optional() }).parse(raw);
  const t = await prisma.supportTicket.findUnique({ where: { id: ticketId }, include: { customer: true } });
  if (!t) throw Errors.notFound("Ticket");
  assertBranchAccess(staff, t.customer.branchId);
  if (input.body) await prisma.ticketMessage.create({ data: { ticketId, authorType: "STAFF", authorId: staff.id, authorName: staff.fullNameEn, body: input.body } });
  const after = await prisma.supportTicket.update({
    where: { id: ticketId },
    data: { status: input.status ?? (input.body && t.status === "OPEN" ? "IN_PROGRESS" : undefined), assignedToId: input.assignToMe ? staff.id : undefined },
  });
  if (input.body) await notify(prisma, t.customerId, { titleAr: "رد على طلبك", titleEn: "Reply to your ticket", bodyAr: `تم الرد على الطلب ${t.ticketNo}`, bodyEn: `Ticket ${t.ticketNo} has a new reply` });
  await audit(actor, "TICKET_UPDATED", { type: "SupportTicket", id: ticketId }, { status: t.status }, { status: after.status });
  return after;
}
