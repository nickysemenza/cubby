import type { FinancialAccountOut } from "@cubby/schemas/financial-account";
import type { FinancialTransactionOut } from "@cubby/schemas/financial-transaction";
import type {
  ProductShortcode,
  ProjectShortcode,
  VendorShortcode,
} from "@cubby/schemas/identifiers";
import type { TaskStatus, Trade } from "@cubby/schemas/project";
import type { WishOut } from "@cubby/schemas/wish";

import type { EntityEditDraft } from "./intent-types";
import type { EditableEntity, EntityEditRequest } from "./types";

type DialogRequest<E extends EditableEntity> = Omit<
  EntityEditRequest<E, "create">,
  "surface"
> & { intent: "capture" };
type MutableDraft<E extends EditableEntity> = {
  -readonly [K in keyof EntityEditDraft<E>]?: EntityEditDraft<E>[K];
};

export const mealCaptureRequest = (input?: {
  date?: string;
}): DialogRequest<"meal"> => ({
  entity: "meal",
  operation: "create",
  intent: "capture",
  seed: input?.date ? { date: input.date } : undefined,
});

export const taskCaptureRequest = (input?: {
  status?: TaskStatus;
  projectId?: ProjectShortcode | null;
  trade?: Trade;
  date?: string;
  name?: string;
  subjectProductId?: ProductShortcode | null;
}): DialogRequest<"task"> => {
  const seed: MutableDraft<"task"> = {};
  if (input?.status) seed.status = input.status;
  if (input?.projectId !== undefined) seed.projectId = input.projectId;
  if (input?.trade) seed.trade = input.trade;
  if (input?.date) seed.dueDate = input.date;
  if (input?.name) seed.name = input.name;
  if (input?.subjectProductId !== undefined) {
    seed.subjectProductId = input.subjectProductId;
  }
  return {
    entity: "task",
    operation: "create",
    intent: "capture",
    seed,
  };
};

export const expenseCaptureRequest = (input?: {
  projectId?: ProjectShortcode | null;
  productId?: ProductShortcode | null;
  date?: string;
  future?: boolean;
  disposition?: boolean;
}): DialogRequest<"expense"> => {
  const seed: MutableDraft<"expense"> = {};
  if (input?.projectId !== undefined) seed.projectId = input.projectId;
  if (input?.productId !== undefined) seed.productId = input.productId;
  if (input?.date) seed.date = input.date;
  if (input?.future !== undefined) seed.future = input.future;
  if (input?.disposition) {
    seed.projectId = null;
    seed.costType = "tools";
  }
  return {
    entity: "expense",
    operation: "create",
    intent: "capture",
    context: { disposition: input?.disposition === true },
    seed,
  };
};

export const projectCaptureRequest = (input?: {
  parentProjectId?: ProjectShortcode | null;
  date?: string;
}): DialogRequest<"project"> => {
  const seed: MutableDraft<"project"> = {};
  if (input?.parentProjectId) seed.parentProjectId = input.parentProjectId;
  if (input?.date) seed.startDate = input.date;
  return {
    entity: "project",
    operation: "create",
    intent: "capture",
    context: { parentProjectId: input?.parentProjectId ?? null },
    seed,
  };
};

export const vendorCaptureRequest = (): DialogRequest<"vendor"> => ({
  entity: "vendor",
  operation: "create",
  intent: "capture",
});

export const purchaseCaptureRequest = (input?: {
  vendorId?: VendorShortcode | null;
}): DialogRequest<"purchase"> => ({
  entity: "purchase",
  operation: "create",
  intent: "capture",
  seed: input?.vendorId ? { vendorId: input.vendorId } : undefined,
});

export const financialAccountCaptureRequest =
  (): DialogRequest<"financialAccount"> => ({
    entity: "financialAccount",
    operation: "create",
    intent: "capture",
  });

export const financialAccountEditRequest = (
  account: FinancialAccountOut,
): Omit<EntityEditRequest<"financialAccount", "update", "full">, "surface"> & {
  intent: "full";
} => ({
  entity: "financialAccount",
  operation: "update",
  intent: "full",
  record: account,
  seed: {
    name: account.name,
    provisional: account.provisional,
    sourceAliases: account.sourceAliases,
    notes: account.notes ?? null,
  },
});

export const financialTransactionCaptureRequest =
  (): DialogRequest<"financialTransaction"> => ({
    entity: "financialTransaction",
    operation: "create",
    intent: "capture",
  });

export const financialTransactionEditRequest = (
  transaction: FinancialTransactionOut,
): Omit<
  EntityEditRequest<"financialTransaction", "update", "full">,
  "surface"
> & {
  intent: "full";
} => ({
  entity: "financialTransaction",
  operation: "update",
  intent: "full",
  record: transaction,
  seed: {
    accountId: transaction.accountId,
    purchaseId: transaction.purchaseId ?? null,
    kind: transaction.kind,
    status: transaction.status,
    amount: transaction.amount,
    transactionDate: transaction.transactionDate ?? "",
    postedDate: transaction.postedDate ?? "",
    merchant: transaction.merchant ?? "",
    rawDescription: transaction.rawDescription ?? "",
    sourceCategory: transaction.sourceCategory ?? "",
    sourceRefs: transaction.sourceRefs,
    notes: transaction.notes ?? "",
  },
});

export const wishCreateRequest = (): Omit<
  EntityEditRequest<"wish", "create", "full">,
  "surface"
> & { intent: "full" } => ({
  entity: "wish",
  operation: "create",
  intent: "full",
});

export const wishEditRequest = (
  wish: WishOut,
): Omit<EntityEditRequest<"wish", "update", "full">, "surface"> & {
  intent: "full";
} => ({
  entity: "wish",
  operation: "update",
  intent: "full",
  record: wish,
  seed: {
    name: wish.name,
    notes: wish.notes,
    candidateProductIds: wish.candidates.map(({ id }) => id),
  },
});
