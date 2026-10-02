import { z } from "zod";
import { publicApi, parseBody } from "@/server/http";
import { customerLoginStart } from "@/server/auth/login";
const schema = z.object({ username: z.string().min(1).max(64), password: z.string().min(1).max(200) });
export const POST = publicApi(async (req, { ip, ua }) => customerLoginStart(await parseBody(req, schema), ip, ua));
