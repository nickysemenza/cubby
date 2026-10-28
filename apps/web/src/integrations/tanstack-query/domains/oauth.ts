import { oauthContract } from "~/contracts/connected-apps.contract";

import { defineOperationDomain } from "../operation-catalog";

export const oauth = /* @__PURE__ */ defineOperationDomain(oauthContract);
