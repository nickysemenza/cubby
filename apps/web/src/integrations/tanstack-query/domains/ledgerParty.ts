import { ledgerPartyContract } from "~/contracts/finance.contract";

import { defineOperationDomain } from "../operation-catalog";

export const ledgerParty =
  /* @__PURE__ */ defineOperationDomain(ledgerPartyContract);
