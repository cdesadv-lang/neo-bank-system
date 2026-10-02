import { staffApi } from "@/server/http";
import { listLoans, applyLoan } from "@/server/services/loans";
export const GET = staffApi("loan.read", async (req, { staff }) => listLoans(staff, { status: new URL(req.url).searchParams.get("status") ?? undefined }));
export const POST = staffApi("loan.apply", async (req, { staff, actor }) => applyLoan(staff, actor, await req.json()));
