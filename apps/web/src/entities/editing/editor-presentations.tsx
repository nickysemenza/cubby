import { entitySummary } from "@cubby/schemas/entity-summary";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { useQuery } from "@tanstack/react-query";
import { format, parseISO } from "date-fns";
import {
  type ComponentProps,
  type ComponentType,
  useEffect,
  useId,
  useMemo,
  useState,
} from "react";
import { type FieldValues, type UseFormReturn } from "react-hook-form";
import { z } from "zod";

import {
  entityDisplayImageKey,
  useEntityDisplayImages,
} from "~/app/_components/entity-media/entity-display-images";
import { EntityInlineLink } from "~/app/_components/EntityInlineLink";
import {
  SelectField as FinanceSelectField,
  SourceAliasesField,
  TextField,
} from "~/app/finance/financial-form-fields";
import {
  FinancialTransactionFormFields,
  type FinancialTransactionFormValues,
} from "~/app/finance/financial-transaction-form";
import { AliasesField } from "~/components/forms/aliases-field";
import { Row, Stack } from "~/components/layout";
import { Checkbox } from "~/components/ui/checkbox";
import { Description } from "~/components/ui/description";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import type { ResponsiveDialog } from "~/components/ui/responsive-dialog";
import { entityListFor } from "~/entities/entity-list.functions";
import { purchaseLabel } from "~/lib/purchase-label";

import {
  EntityIntentFields,
  EntityPrimitiveFields,
} from "./entity-primitive-fields";
import type { EntityEditResultFor } from "./intent-types";
import type {
  EntityEditContext,
  EntityEditOperation,
  EntityEditRecord,
  EditableEntity,
} from "./types";

type EntityEditorForm = UseFormReturn<FieldValues>;

interface EntityEditorFieldsProps {
  form: EntityEditorForm;
  context: EntityEditContext;
  record?: EntityEditRecord;
}

export interface EntityEditorPresentation<E extends EditableEntity> {
  title(input: {
    context: EntityEditContext;
    record?: EntityEditRecord;
  }): string;
  description(input: {
    context: EntityEditContext;
    record?: EntityEditRecord;
  }): string;
  submitLabel?: string;
  size?: ComponentProps<typeof ResponsiveDialog>["size"];
  Fields: ComponentType<EntityEditorFieldsProps>;
  successMessage(result: EntityEditResultFor<E>): string;
}

const resultName = (
  result: EntityEditResultFor<EditableEntity>,
  fallback: string,
) => {
  const parsed = z
    .object({ name: z.string().nullable().optional() })
    .parse(result);
  return parsed.name || fallback;
};

function MealCaptureFields() {
  return <EntityIntentFields entity="meal" intent="capture" />;
}

function TaskCaptureFields() {
  return <EntityIntentFields entity="task" intent="capture" />;
}

/**
 * `EntityIntentFields` renders every "capture"-roster field generically,
 * `name` focused first (its own special case, mirroring the old hand-rolled
 * `focusOnMount`). Two behaviors the hand-rolled version had are accepted
 * losses (see the plan): the "Planned" switch's date label no longer flips
 * between "Expected date"/"Expense date" (`future`'s manifest checkbox has a
 * fixed label), and the vendor placeholder no longer varies with
 * `context.disposition` ("Sold to / given to" vs "Where from?").
 */
function ExpenseCaptureFields() {
  return <EntityIntentFields entity="expense" intent="capture" />;
}

function ProjectCaptureFields() {
  return <EntityIntentFields entity="project" intent="capture" />;
}

/**
 * Live duplicate-name check for ingredient CREATE only — an edit dialog
 * watches the same field but starting from the record's own name, which
 * would otherwise flag itself as a duplicate on every keystroke. Reuses
 * `ingredient.list`'s name filter (the same fuzzy search the pickers use).
 */
function IngredientDuplicateNameHint({ form }: EntityEditorFieldsProps) {
  const name = z.string().catch("").parse(form.watch("name"));
  const [debouncedName] = useDebouncedValue(name, { wait: 300 });
  const trimmed = debouncedName.trim();
  const enabled = trimmed.length >= 2;

  const { data } = useQuery({
    ...entityListFor("ingredient").queryOptions({
      filters: { nameFilter: trimmed },
      pagination: { pageIndex: 0, pageSize: 5 },
    }),
    enabled,
  });

  const matches = useMemo(() => data?.items ?? [], [data?.items]);
  const matchRefs = useMemo(
    () =>
      matches.map((match) => ({
        entityType: "ingredient" as const,
        entityId: match.id,
      })),
    [matches],
  );
  const displayImages = useEntityDisplayImages(matchRefs);
  if (!enabled || matches.length === 0) return null;

  const lower = trimmed.toLowerCase();
  const exact = matches.some(
    (m) =>
      m.name.toLowerCase() === lower ||
      m.aliases.some((a) => a.toLowerCase() === lower),
  );

  return (
    <Stack gap="xs">
      <Description size="xs" className={exact ? "text-warning-ink" : undefined}>
        {exact
          ? "An ingredient with this name already exists — did you mean to use it?"
          : "Similar ingredients already exist. Use one of these instead of creating a duplicate?"}
      </Description>
      <Row gap="xs" wrap>
        {matches.map((m) => (
          <EntityInlineLink
            displayImage={
              displayImages[
                entityDisplayImageKey({
                  entityType: "ingredient",
                  entityId: m.id,
                })
              ] ?? null
            }
            key={m.id}
            entity="ingredient"
            data={{ name: m.name, id: m.id }}
          />
        ))}
      </Row>
    </Stack>
  );
}

function IngredientCaptureFields(props: EntityEditorFieldsProps) {
  return (
    <>
      <EntityIntentFields entity="ingredient" intent="capture" />
      <IngredientDuplicateNameHint {...props} />
    </>
  );
}

function IngredientFullFields() {
  return <EntityIntentFields entity="ingredient" intent="full" mode="edit" />;
}

function InventoryCaptureFields() {
  return <EntityIntentFields entity="inventory" intent="capture" />;
}

function InventoryFullFields() {
  return <EntityIntentFields entity="inventory" intent="full" mode="edit" />;
}

/**
 * Location's rich fields beyond what `EntityIntentFields` renders generically:
 * `type` is a manifest `select` control (`control.suggest: { basis: ["name"] }`)
 * like any other suggestable enum, so `EntityIntentFields` renders it and its
 * auto-suggest hint with no hand-written wiring here. `collections` is a pure
 * editor-only pseudo field (folded into the stored `tags` at submit by
 * `locationBuildData` in `definitions.ts`) shown only once a location exists —
 * the create dialog stays a quick add; aliases/collections/photos are filled
 * in afterward from the edit dialog.
 */
function LocationFields({ form, record }: EntityEditorFieldsProps) {
  const editing = record !== undefined;
  return (
    <>
      <EntityIntentFields
        entity="location"
        intent={editing ? "full" : "capture"}
        mode={editing ? "edit" : "create"}
      />
      {editing && (
        <AliasesField
          form={form}
          name="collections"
          title="Collections"
          addButtonText="Add Collection"
          placeholder="e.g. painting"
        />
      )}
    </>
  );
}

function VendorCaptureFields() {
  return <EntityIntentFields entity="vendor" intent="capture" />;
}

function PurchaseCaptureFields() {
  return <EntityIntentFields entity="purchase" intent="capture" />;
}

function FinancialAccountFields({ form, record }: EntityEditorFieldsProps) {
  const kind = form.watch("kind");
  const creating = !record;
  return (
    <>
      <EntityPrimitiveFields
        entity="financialAccount"
        mode={creating ? "create" : "edit"}
        section="main"
        options={{
          name: { focusOnMount: true },
          notes: { placeholder: "Optional evidence" },
        }}
      />
      {creating ? (
        <>
          <FinanceSelectField
            form={form}
            name="kind"
            label="Identity kind"
            values={[
              "credit_card",
              "bank_account",
              "stored_value",
              "cash",
              "other",
            ]}
          />
          {kind === "credit_card" ? (
            <>
              <TextField form={form} name="issuer" label="Issuer" />
              <FinanceSelectField
                form={form}
                name="network"
                label="Network"
                values={["visa", "mastercard", "amex", "discover", "other"]}
              />
            </>
          ) : null}
          {kind === "bank_account" ? (
            <>
              <TextField form={form} name="institution" label="Institution" />
              <FinanceSelectField
                form={form}
                name="accountType"
                label="Account type"
                values={["checking", "savings", "money_market", "other"]}
              />
            </>
          ) : null}
          {kind === "stored_value" ? (
            <TextField form={form} name="provider" label="Provider" />
          ) : null}
          {kind === "other" ? (
            <TextField form={form} name="institution" label="Institution" />
          ) : null}
          {kind !== "cash" ? (
            <TextField form={form} name="last4" label="Last four" />
          ) : null}
        </>
      ) : null}
      <SourceAliasesField form={form} />
    </>
  );
}

function FinancialTransactionFields({ form, record }: EntityEditorFieldsProps) {
  const transactionForm = z
    .custom<UseFormReturn<FinancialTransactionFormValues>>()
    .parse(form);
  return (
    <FinancialTransactionFormFields
      form={transactionForm}
      mode={record ? "edit" : "create"}
    />
  );
}

type CandidateOption = {
  id: string;
  name: string;
  manufacturer: string;
};
const candidateOptions = z.array(
  z.object({ id: z.string(), name: z.string(), manufacturer: z.string() }),
);

function WishFields({ form, record }: EntityEditorFieldsProps) {
  const [productSearch, setProductSearch] = useState("");
  const [selectedProducts, setSelectedProducts] = useState<CandidateOption[]>(
    [],
  );
  const [debouncedProductSearch] = useDebouncedValue(productSearch, {
    wait: 300,
  });
  const idPrefix = useId();
  const candidateIds = z
    .array(z.string())
    .catch([])
    .parse(form.watch("candidateProductIds"));
  const recordCandidates =
    record && "candidates" in record ? record.candidates : undefined;
  const candidates = useMemo(
    () => candidateOptions.catch([]).parse(recordCandidates),
    [recordCandidates],
  );

  useEffect(() => {
    setSelectedProducts(candidates);
  }, [candidates]);

  const productsQuery = useQuery(
    entityListFor("product").queryOptions({
      filters: {
        nameFilter: debouncedProductSearch.trim() || undefined,
        categoryFilter: "tools",
      },
      sort: [{ orderBy: "name", direction: "asc" }],
      pagination: { pageIndex: 0, pageSize: 50 },
    }),
  );
  const productOptions = [
    ...selectedProducts,
    ...(productsQuery.data?.items ?? []).filter(
      (product) => !candidateIds.includes(product.id),
    ),
  ];
  const toggleCandidate = (product: CandidateOption, checked: boolean) => {
    form.setValue(
      "candidateProductIds",
      checked
        ? [...candidateIds, product.id]
        : candidateIds.filter((id) => id !== product.id),
      { shouldDirty: true },
    );
    setSelectedProducts((current) =>
      checked
        ? current.some(({ id }) => id === product.id)
          ? current
          : [...current, product]
        : current.filter(({ id }) => id !== product.id),
    );
  };

  return (
    <>
      <EntityPrimitiveFields
        entity="wish"
        mode={record ? "edit" : "create"}
        section="main"
        options={{
          name: {
            placeholder: "e.g. Metal milling machine",
            focusOnMount: true,
          },
          notes: {
            placeholder:
              "Why it would be useful or fun, constraints, future project ideas…",
          },
        }}
      />
      <div className="grid gap-2">
        <Label htmlFor={`${idPrefix}-product-search`}>Tool alternatives</Label>
        <Input
          id={`${idPrefix}-product-search`}
          value={productSearch}
          onChange={(event) => setProductSearch(event.target.value)}
          placeholder="Filter your Tool products…"
        />
        <div className="grid max-h-48 gap-1 overflow-y-auto border p-2">
          {productOptions.map((product) => {
            const checked = candidateIds.includes(product.id);
            const inputId = `${idPrefix}-${product.id}`;
            return (
              <Row
                key={product.id}
                align="center"
                gap="sm"
                className="p-1 hover:bg-muted"
              >
                <Checkbox
                  id={inputId}
                  checked={checked}
                  onCheckedChange={(value) =>
                    toggleCandidate(product, value === true)
                  }
                />
                <Label
                  htmlFor={inputId}
                  className="min-w-0 cursor-pointer tracking-normal normal-case"
                >
                  <span className="block truncate font-medium">
                    {product.name}
                  </span>
                  <span className="block truncate text-muted-foreground">
                    {product.manufacturer}
                  </span>
                </Label>
              </Row>
            );
          })}
          {!productsQuery.isLoading && productOptions.length === 0 ? (
            <p className="p-1 text-muted-foreground">
              No matching Tool products yet.
            </p>
          ) : null}
        </div>
        <p className="text-muted-foreground">
          Choose any number of alternatives. They mean “pick one,” not a
          shopping cart.
        </p>
      </div>
    </>
  );
}

type EntityEditorPresentationKey =
  | "meal:create:capture"
  | "task:create:capture"
  | "expense:create:capture"
  | "project:create:capture"
  | "vendor:create:capture"
  | "purchase:create:capture"
  | "financialAccount:create:capture"
  | "financialAccount:update:full"
  | "financialTransaction:create:capture"
  | "financialTransaction:update:full"
  | "wish:create:full"
  | "wish:update:full"
  | "ingredient:create:capture"
  | "ingredient:update:full"
  | "inventory:create:capture"
  | "inventory:update:full"
  | "location:create:capture"
  | "location:update:full";

interface PresentationEntityByKey {
  "meal:create:capture": "meal";
  "task:create:capture": "task";
  "expense:create:capture": "expense";
  "project:create:capture": "project";
  "vendor:create:capture": "vendor";
  "purchase:create:capture": "purchase";
  "financialAccount:create:capture": "financialAccount";
  "financialAccount:update:full": "financialAccount";
  "financialTransaction:create:capture": "financialTransaction";
  "financialTransaction:update:full": "financialTransaction";
  "wish:create:full": "wish";
  "wish:update:full": "wish";
  "ingredient:create:capture": "ingredient";
  "ingredient:update:full": "ingredient";
  "inventory:create:capture": "inventory";
  "inventory:update:full": "inventory";
  "location:create:capture": "location";
  "location:update:full": "location";
}

const presentations = {
  "meal:create:capture": {
    title: () => "New Meal",
    description: () =>
      "Plan a meal onto the calendar — add recipes once it's created.",
    Fields: MealCaptureFields,
    successMessage: (result) => {
      if (result.name) {
        return `Added "${result.name}"`;
      }
      return `Added meal for ${format(parseISO(result.date), "EEE, MMM d")}`;
    },
  },
  "task:create:capture": {
    title: () => "New Task",
    description: () =>
      "Add a step to work through — optionally attach it to a project or product.",
    Fields: TaskCaptureFields,
    successMessage: (result) => `Added "${resultName(result, "task")}"`,
  },
  "expense:create:capture": {
    title: ({ context }) =>
      context.disposition === true ? "Record Sale or Disposal" : "New Expense",
    description: ({ context }) =>
      context.disposition === true
        ? "Enter a negative cost for a sale or return, or 0 with a negative quantity if it broke or was given away."
        : "Log what you bought (or plan to) — the fastest way to keep a project's cost honest.",
    Fields: ExpenseCaptureFields,
    successMessage: (result) => `Logged "${resultName(result, "expense")}"`,
  },
  "project:create:capture": {
    title: ({ context }) =>
      context.parentProjectId ? "New Sub-project" : "New Project",
    description: () =>
      "Start tracking a household undertaking — tasks and expenses attach to it afterward.",
    Fields: ProjectCaptureFields,
    successMessage: (result) => `Added "${resultName(result, "project")}"`,
  },
  "vendor:create:capture": {
    title: () => "New Vendor",
    description: () =>
      "A place money goes. Purchases attach to it afterward; all spend lives on their expenses.",
    Fields: VendorCaptureFields,
    successMessage: (result) => `Added "${resultName(result, "vendor")}"`,
  },
  "purchase:create:capture": {
    title: () => "New Purchase",
    description: () =>
      "One vendor order or receipt event. Its Expenses are the categorized spend lines added afterward, and every dollar lives on them.",
    Fields: PurchaseCaptureFields,
    successMessage: (result) => `Logged "${purchaseLabel(result)}"`,
  },
  "financialAccount:create:capture": {
    title: () => "New Account",
    description: () =>
      "A settlement account, not a source of spend. Use its source aliases as evidence from statements and receipts.",
    Fields: FinancialAccountFields,
    successMessage: () => "Account created",
  },
  "financialAccount:update:full": {
    title: () => "Edit Account",
    description: () =>
      "Aliases replace the complete evidence list. Keep every source row you still need.",
    submitLabel: "Save changes",
    Fields: FinancialAccountFields,
    successMessage: () => "Account updated",
  },
  "financialTransaction:create:capture": {
    title: () => "New Transaction",
    description: () =>
      "Settlement evidence only. Amounts never change expense spend or project budgets.",
    Fields: FinancialTransactionFields,
    successMessage: () => "Transaction created",
  },
  "financialTransaction:update:full": {
    title: () => "Edit Transaction",
    description: () =>
      "References replace the complete evidence list. Preserve previous statement references when appending new evidence.",
    submitLabel: "Save transaction",
    Fields: FinancialTransactionFields,
    successMessage: () => "Transaction updated",
  },
  "wish:create:full": {
    title: () => "New wishlist item",
    description: () =>
      "Add one desired outcome, then optionally list the Tool products you would consider.",
    size: "lg",
    Fields: WishFields,
    successMessage: (result) => `Created “${resultName(result, "wish")}”`,
  },
  "wish:update:full": {
    title: () => "Edit wishlist item",
    description: () =>
      "Add one desired outcome, then optionally list the Tool products you would consider.",
    submitLabel: "Save changes",
    size: "lg",
    Fields: WishFields,
    successMessage: () => "Wishlist updated",
  },
  "ingredient:create:capture": {
    title: () => "New Ingredient",
    description: () =>
      "A canonical cooking ingredient — products and recipes link to it afterward.",
    Fields: IngredientCaptureFields,
    successMessage: (result) => `Added "${resultName(result, "ingredient")}"`,
  },
  "ingredient:update:full": {
    title: () => "Edit Ingredient",
    description: () => "Aliases replace the complete alternate-name list.",
    submitLabel: "Save changes",
    Fields: IngredientFullFields,
    successMessage: () => "Ingredient updated",
  },
  "inventory:create:capture": {
    title: () => "Add to Inventory",
    description: () => "Record an approximate quantity at a physical location.",
    Fields: InventoryCaptureFields,
    successMessage: () => "Added to inventory",
  },
  "inventory:update:full": {
    title: () => "Edit Inventory Item",
    description: () =>
      "Move it, correct the quantity, or flip it between stock and installed.",
    submitLabel: "Save changes",
    Fields: InventoryFullFields,
    successMessage: () => "Inventory item updated",
  },
  "location:create:capture": {
    title: () => "Create New Location",
    description: () =>
      "Alternate names, collections, and photos can be added afterward from the location's own page.",
    Fields: LocationFields,
    successMessage: (result) => `Added "${resultName(result, "location")}"`,
  },
  "location:update:full": {
    title: () => "Edit Location",
    description: () =>
      "Aliases and collections each replace their complete list.",
    submitLabel: "Save changes",
    size: "lg",
    Fields: LocationFields,
    successMessage: () => "Location updated",
  },
} satisfies {
  [K in EntityEditorPresentationKey]: EntityEditorPresentation<
    PresentationEntityByKey[K]
  >;
};

/**
 * The presentation every entity gets without a hand-written one: the
 * intent's declared fields in model order (`EntityIntentFields`), titled from
 * the manifest singular. A bespoke entry above wins when it exists — it
 * carries copy or a field layout the declaration cannot express.
 */
function genericPresentation<E extends EditableEntity>(input: {
  entity: E;
  operation: EntityEditOperation;
  intent: string;
}): EntityEditorPresentation<E> {
  const { singular } = entitySummary[input.entity];
  const isUpdate = input.operation === "update";
  const Fields = () => (
    <EntityIntentFields
      entity={input.entity}
      intent={input.intent}
      mode={isUpdate ? "edit" : "create"}
    />
  );
  return {
    title: () => (isUpdate ? `Edit ${singular}` : `New ${singular}`),
    description: () =>
      isUpdate
        ? `Change this ${singular.toLocaleLowerCase()}'s own fields.`
        : `Add a ${singular.toLocaleLowerCase()}.`,
    submitLabel: isUpdate ? "Save changes" : "Create",
    Fields,
    successMessage: () =>
      isUpdate ? `${singular} updated` : `${singular} created`,
  };
}

// One generic presentation per key: the dialog resolves its presentation on
// every render, and a fresh `Fields` component identity would remount the
// whole form on each value change — dropping focus mid-click and the
// keystrokes that follow (a date commit on blur showed exactly that).
const genericPresentations = new Map<string, EntityEditorPresentation<never>>();

export function getEntityEditorPresentation<E extends EditableEntity>(input: {
  entity: E;
  operation: EntityEditOperation;
  intent: string;
}): EntityEditorPresentation<E> {
  const key = `${input.entity}:${input.operation}:${input.intent}`;
  const presentation = Object.entries(presentations).find(
    ([candidate]) => candidate === key,
  )?.[1];
  if (presentation === undefined) {
    const cached = genericPresentations.get(key);
    if (cached !== undefined) {
      // SAFETY: the cache is keyed by entity, so the entry is this entity's.
      return cached as EntityEditorPresentation<E>;
    }
    const generic = genericPresentation(input);
    // SAFETY: stored under this entity's key; read back only for that key.
    genericPresentations.set(key, generic as EntityEditorPresentation<never>);
    return generic;
  }
  // SAFETY: `presentations` is keyed `${entity}:${operation}:${intent}` and
  // each value is typed against that key's entity; the string match above
  // recovers the entry for this call's entity.
  return presentation as EntityEditorPresentation<E>;
}
