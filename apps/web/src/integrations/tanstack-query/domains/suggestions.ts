import { suggestionsContract } from "~/contracts/suggestions.contract";

import { defineOperationDomain } from "../operation-catalog";

export const suggestions =
  /* @__PURE__ */ defineOperationDomain(suggestionsContract);
