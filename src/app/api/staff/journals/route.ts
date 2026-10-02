import { staffApi } from "@/server/http";
import { listJournals } from "@/server/services/journals";
export const GET = staffApi("journal.read", async (req, { staff }) => {
  const u = new URL(req.url);
  return listJournals(staff, { q: u.searchParams.get("q") ?? undefined, type: u.searchParams.get("type") ?? undefined });
});
