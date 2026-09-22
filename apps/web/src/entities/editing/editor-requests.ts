import { entityFieldModels } from "@cubby/schemas/entity-fields";
import type { FinancialAccountOut } from "@cubby/schemas/financial-account";
import type { FinancialTransactionOut } from "@cubby/schemas/financial-transaction";
import type {
  ProductShortcode,
  ProjectShortcode,
} from "@cubby/schemas/identifiers";
import type { inventoryWithLocationAndProductOut } from "@cubby/schemas/inventory";
import type { InfLocation } from "@cubby/schemas/location";
import type { TaskStatus, Trade } from "@cubby/schemas/project";
import type { WishOut } from "@cubby/schemas/wish";
import type { z } from "zod";

import { readReferenceField } from "../entity-references";
import type { EntityEditDraft } from "./intent-types";
import type { EditableEntity, EntityEditRequest } from "./types";

type DialogRequest<E extends EditableEntity> = Omit<
  EntityEditRequest<E, "create">,
  "surface"
> & { intent: "capture" };
type MutableDraft<E extends EditableEntity> = {
  -readonly [K in keyof EntityEditDraft<E>]?: EntityEditDraft<E>[K];
};

/**
 * A create-intent "capture" dialog request with no fields beyond an optional
 * seed — the request every entity with no bespoke capture logic needs, and
 * what the generated list routes open. Entities whose capture request
 * derives fields from its input (context, defaulted seed values) keep their
 * own hand-written builder below instead of folding into this one.
 */
export function captureRequest<E extends EditableEntity>(
  entity: E,
  seed?: MutableDraft<E>,
): DialogRequest<E> {
  // SAFETY: `DialogRequest<E>`'s `intent` is `EntityEditIntent<E, "create">`,
  // a per-entity lookup the compiler can't verify includes `"capture"` for an
  // opaque generic `E`; every caller below only ever instantiates this with
  // an entity whose editing registry declares `"capture"` as a valid create
  // intent: the hand-written builders below, and the generated list routes,
  // whose `route.create: "dialog"` the entity compiler checks against
  // `model.intents.create`.
  const request = {
    entity,
    operation: "create",
    intent: "capture",
  } as DialogRequest<E>;
  if (seed !== undefined) request.seed = seed;
  return request;
}

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
  beneficiaries?: EntityEditDraft<"expense">["beneficiaries"];
}): DialogRequest<"expense"> => {
  const seed: MutableDraft<"expense"> = {};
  if (input?.projectId !== undefined) seed.projectId = input.projectId;
  if (input?.productId !== undefined) seed.productId = input.productId;
  if (input?.date) seed.date = input.date;
  if (input?.future !== undefined) seed.future = input.future;
  if (input?.beneficiaries !== undefined)
    seed.beneficiaries = input.beneficiaries;
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

/**
 * The rich "full" create request (unlike `captureRequest("product")`'s
 * name+manufacturer-only quick add) — used where a caller has more than a
 * bare name to seed: the USDA food detail page's "create product"/"link to
 * an ingredient" actions.
 */
export const productCreateRequest = (input?: {
  name?: string;
  manufacturer?: string;
  upc?: string | null;
  fdcId?: number | null;
  ingredientId?: EntityEditDraft<"product">["ingredientId"];
}): Omit<EntityEditRequest<"product", "create", "full">, "surface"> & {
  intent: "full";
} => {
  const seed: MutableDraft<"product"> = {};
  if (input?.name) seed.name = input.name;
  if (input?.manufacturer) seed.manufacturer = input.manufacturer;
  if (input?.upc !== undefined) seed.upc = input.upc;
  if (input?.fdcId !== undefined) seed.fdc_id = input.fdcId;
  if (input?.ingredientId !== undefined) seed.ingredientId = input.ingredientId;
  return { entity: "product", operation: "create", intent: "full", seed };
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

const financialAccountEditRequest = (
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

const wishEditRequest = (
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

const inventoryEditRequest = (
  item: z.infer<typeof inventoryWithLocationAndProductOut>,
): Omit<EntityEditRequest<"inventory", "update", "full">, "surface"> & {
  intent: "full";
} => ({
  entity: "inventory",
  operation: "update",
  intent: "full",
  record: item,
  // `productId`/`locationId` project only as the nested `product`/`location`
  // relation objects on this read shape — the generic `initial` lookup reads
  // the record by field key, so the bare ids need an explicit seed.
  seed: {
    productId: item.product.id,
    locationId: item.location.id,
  },
});

const locationEditRequest = (
  location: InfLocation,
): Omit<EntityEditRequest<"location", "update", "full">, "surface"> & {
  intent: "full";
} => ({
  entity: "location",
  operation: "update",
  intent: "full",
  record: location,
  // `productId`/`parentId` project only as the nested `product`/`parent`
  // relation objects — same reasoning as `inventoryEditRequest` above.
  seed: {
    productId: location.product?.id ?? null,
    parentId: location.parent?.id ?? null,
  },
});

type UpdateRequest<E extends EditableEntity> = Omit<
  EntityEditRequest<E, "update">,
  "surface" | "intent"
> & { intent: "full" };

/**
 * The per-entity update requests whose seed cannot be read off the record
 * by field key: a projection that nests a reference under another key, or
 * an editor field folded from several record fields.
 */
const bespokeEditRequests = {
  financialAccount: financialAccountEditRequest,
  financialTransaction: financialTransactionEditRequest,
  wish: wishEditRequest,
  inventory: inventoryEditRequest,
  location: locationEditRequest,
} as const;

type BespokeEditRequest = (record: never) => UpdateRequest<EditableEntity>;

/** One bespoke builder, read through the erased map. */
const bespokeEditRequestFor = (
  entity: EditableEntity,
): BespokeEditRequest | undefined =>
  Object.hasOwn(bespokeEditRequests, entity)
    ? // SAFETY: `hasOwn` proves `entity` is one of the map's own keys.
      bespokeEditRequests[entity as keyof typeof bespokeEditRequests]
    : undefined;

/**
 * The generic `update:full` request for a detail record. Single reference
 * fields are seeded from wherever the projection carries them
 * (`readReferenceField`: `<key>`, `<key minus Id>.id`), so a nested relation
 * object needs no per-entity seed; a bespoke builder above still wins.
 */
export function detailEditRequest<E extends EditableEntity>(
  entity: E,
  record: { id: string },
): UpdateRequest<E> {
  const bespoke = bespokeEditRequestFor(entity);
  if (bespoke !== undefined) {
    // SAFETY: `bespokeEditRequestFor(entity)` is the builder for exactly
    // this entity, so its request is this entity's own `update:full` and
    // `record` is the detail record it was typed against.
    const built = bespoke(record as never) as UpdateRequest<E>;
    return built;
  }
  const seed: Partial<Record<string, string | null>> = {};
  for (const field of entityFieldModels[entity].fields) {
    if (field.reference === null || field.reference.multiple) continue;
    const reference = readReferenceField(record, field);
    if (reference === null) continue;
    seed[field.key] = reference.items[0]?.id ?? null;
  }
  // SAFETY: the seed names this entity's own single-reference fields with
  // the shortcodes its record carries; the registry validates every value,
  // which is what lets this generic builder stand in for a typed draft.
  return {
    entity,
    operation: "update",
    intent: "full",
    record,
    seed,
  } as UpdateRequest<E>;
}
