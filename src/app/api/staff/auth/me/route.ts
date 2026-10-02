import { staffApi } from "@/server/http";
import { ROLE_PERMISSIONS } from "@/server/rbac";
export const GET = staffApi(null, async (_req, { staff }) => ({ staff, permissions: ROLE_PERMISSIONS[staff.role] }));
