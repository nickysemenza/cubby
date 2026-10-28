import { sourceTransactionRecordContract } from "~/contracts/source-transaction-record.contract";

import { defineOperationDomain } from "../operation-catalog";

export const sourceTransactionRecord = /* @__PURE__ */ defineOperationDomain(
  sourceTransactionRecordContract,
);
