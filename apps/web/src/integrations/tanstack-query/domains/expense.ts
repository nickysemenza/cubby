import { expenseContract } from "~/contracts/expense.contract";

import { defineOperationDomain } from "../operation-catalog";

export const expense = /* @__PURE__ */ defineOperationDomain(expenseContract);
