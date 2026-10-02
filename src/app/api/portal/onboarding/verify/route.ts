import { publicApi } from "@/server/http";
import { completeOnboarding } from "@/server/services/portal";
export const POST = publicApi(async (req, { ip, ua }) => completeOnboarding(await req.json(), ip, ua));
