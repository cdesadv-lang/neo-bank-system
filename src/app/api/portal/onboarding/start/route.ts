import { publicApi } from "@/server/http";
import { startOnboarding } from "@/server/services/portal";
export const POST = publicApi(async (req, { ip }) => startOnboarding(await req.json(), ip));
