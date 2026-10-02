import { staffApi } from "@/server/http";
import { requestManualJournal } from "@/server/services/journals";
export const POST = staffApi("journal.manual", async (req, { staff, actor }) => requestManualJournal(staff, actor, await req.json()));
