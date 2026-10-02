import { portalApi } from "@/server/http";
import { removeBeneficiary } from "@/server/services/portal";
export const DELETE = portalApi(async (_req, { customer, actor, params }) => removeBeneficiary(customer, actor, params.id));
