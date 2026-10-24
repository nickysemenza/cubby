import { z } from "zod";

import type { CorrectionRepairAdapter } from "~/server/generic/assessment/correction-repair";

// No semantic financial repair plan is supported by the current domain commands.
const plan = z.never();

const statementReason =
  "Statement kind/category correction propagation is not supported. Source amount/withdrawal corrections require separate source proof and cannot authorize semantic repair.";
const transferReason =
  "Transfer-pair correction propagation is not supported. Re-pairing requires supported current pair authority; source amount/withdrawal proof cannot authorize it.";

export const statementTransactionCorrectionRepair: CorrectionRepairAdapter<
  typeof plan
> = {
  plan,
  prepare: async () => ({ status: "held", reason: statementReason }),
  apply: async () => ({ status: "held", reason: statementReason }),
};

export const transferPairCorrectionRepair: CorrectionRepairAdapter<
  typeof plan
> = {
  plan,
  prepare: async () => ({ status: "held", reason: transferReason }),
  apply: async () => ({ status: "held", reason: transferReason }),
};
