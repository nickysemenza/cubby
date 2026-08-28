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
import {
  Controller,
  type FieldValues,
  type UseFormReturn,
} from "react-hook-form";
import { z } from "zod";

import {
  WithProductSearch,
  WithProjectSearch,
} from "~/app/_components/combobox/with-search-hook";
import { WithVendorShortcodeSearch } from "~/app/_components/combobox/with-vendor-search";
import {
  NullableNumericField,
  NullableTextareaField,
  PlainDateField,
  SelectField,
  UnifiedTextField,
} from "~/app/_components/form-utils";
import { EntityValueField } from "~/app/_components/form-utils/entity-value-field";
import { VendorField } from "~/app/_components/form-utils/vendor-field";
import { FormFieldGroup } from "~/app/_components/forms/form-field-group";
import {
  costTypeOptions,
  expenseLineKindOptions,
} from "~/app/expenses/expense-options";
import {
  SelectField as FinanceSelectField,
  SourceAliasesField,
  TextField,
} from "~/app/finance/financial-form-fields";
import {
  FinancialTransactionFormFields,
  type FinancialTransactionFormValues,
} from "~/app/finance/financial-transaction-form";
import { mealKindOptions, mealTypeOptions } from "~/app/meals/meal-options";
import { projectKindOptions } from "~/app/projects/project-options";
import { PROJECT_STATUS_OPTIONS, tradeOptions } from "~/app/projects/shared";
import { taskStatusOptions } from "~/app/tasks/task-options";
import { Row } from "~/components/layout";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import type { ResponsiveDialog } from "~/components/ui/responsive-dialog";
import { Switch } from "~/components/ui/switch";
import { entityListFor } from "~/entities/entity-list.functions";
import { purchaseLabel } from "~/lib/purchase-label";

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

function MealCaptureFields({ form }: EntityEditorFieldsProps) {
  return (
    <>
      <PlainDateField form={form} name="date" label="Date" />
      <UnifiedTextField
        form={form}
        name="name"
        label="Name"
        placeholder="Meal name (optional)"
        focusOnMount
        nullable
      />
      <SelectField
        form={form}
        name="mealType"
        label="Meal type"
        options={mealTypeOptions}
        placeholder="Which meal of the day?"
        nullable
      />
      <SelectField
        form={form}
        name="mealKind"
        label="Kind"
        options={mealKindOptions}
        description="Eating out or ordering in? Leave the recipes empty — that's a complete record, not an unfinished one."
      />
    </>
  );
}

function TaskCaptureFields({ form }: EntityEditorFieldsProps) {
  return (
    <>
      <UnifiedTextField
        form={form}
        name="name"
        label="Name"
        placeholder="What needs doing?"
        focusOnMount
      />
      <SelectField
        form={form}
        name="status"
        label="Status"
        options={taskStatusOptions}
      />
      <SelectField
        form={form}
        name="trade"
        label="Trade"
        options={tradeOptions}
        nullable
      />
      <EntityValueField<FieldValues, "project">
        form={form}
        name="projectId"
        entity="project"
        label="Project"
        SearchProvider={WithProjectSearch}
        clearable
      />
      <EntityValueField<FieldValues, "product">
        form={form}
        name="subjectProductId"
        entity="product"
        label="For"
        SearchProvider={WithProductSearch}
        clearable
      />
      <PlainDateField form={form} name="dueDate" label="Due date" />
    </>
  );
}

function ExpenseCaptureFields({ form, context }: EntityEditorFieldsProps) {
  const productId = form.watch("productId");
  const parsedProductId = z.string().safeParse(productId);
  const hasProduct = parsedProductId.success && parsedProductId.data.length > 0;
  const disposition = context.disposition === true;
  return (
    <>
      <UnifiedTextField
        form={form}
        name="name"
        label="Name"
        placeholder="What did you buy?"
        focusOnMount
      />
      {!hasProduct ? (
        <SelectField
          form={form}
          name="lineKind"
          label="Line kind"
          options={[
            { value: "auto", label: "Auto-detect from name" },
            ...expenseLineKindOptions,
          ]}
        />
      ) : null}
      <NullableNumericField
        form={form}
        name="cost"
        label="Cost"
        placeholder="e.g. 24.99"
        step="0.01"
        prefix="$"
      />
      {hasProduct ? (
        <NullableNumericField
          form={form}
          name="productQuantity"
          label="Product quantity"
          placeholder="Unknown"
          step="any"
        />
      ) : null}
      <Controller
        control={form.control}
        name="future"
        render={({ field }) => (
          <>
            <FormFieldGroup label="Planned">
              <Row align="center" gap="sm">
                <Switch
                  checked={field.value === true}
                  onCheckedChange={field.onChange}
                />
                <span className="text-sm text-muted-foreground">
                  {field.value === true ? "Not bought yet" : "Already bought"}
                </span>
              </Row>
            </FormFieldGroup>
            <PlainDateField
              form={form}
              name="date"
              label={field.value === true ? "Expected date" : "Expense date"}
            />
          </>
        )}
      />
      <SelectField
        form={form}
        name="costType"
        label="Cost Type"
        options={costTypeOptions}
      />
      <SelectField
        form={form}
        name="trade"
        label="Trade"
        options={tradeOptions}
      />
      <VendorField
        form={form}
        name="vendor"
        label="Vendor"
        placeholder={disposition ? "Sold to / given to" : "Where from?"}
      />
      <UnifiedTextField
        form={form}
        name="orderId"
        label="Order #"
        placeholder="Vendor order #"
      />
      <EntityValueField<FieldValues, "project">
        form={form}
        name="projectId"
        entity="project"
        label="Project"
        SearchProvider={WithProjectSearch}
        clearable
      />
    </>
  );
}

function ProjectCaptureFields({ form }: EntityEditorFieldsProps) {
  return (
    <>
      <UnifiedTextField
        form={form}
        name="name"
        label="Name"
        placeholder="What are you working on?"
        focusOnMount
      />
      <SelectField
        form={form}
        name="status"
        label="Status"
        options={PROJECT_STATUS_OPTIONS}
      />
      <SelectField
        form={form}
        name="kind"
        label="Kind"
        options={projectKindOptions}
        nullable
      />
      <NullableNumericField
        form={form}
        name="costEstimate"
        label="Cost estimate"
        placeholder="e.g. 500"
        step="0.01"
        prefix="$"
      />
      <PlainDateField form={form} name="startDate" label="Start date" />
    </>
  );
}

function VendorCaptureFields({ form }: EntityEditorFieldsProps) {
  return (
    <>
      <UnifiedTextField
        form={form}
        name="name"
        label="Name"
        placeholder="Who are you paying?"
        focusOnMount
      />
      <UnifiedTextField
        form={form}
        name="website"
        label="Website"
        placeholder="https://…"
        nullable
      />
      <NullableTextareaField
        form={form}
        name="notes"
        label="Notes"
        placeholder="Account number, rep, delivery quirks…"
      />
    </>
  );
}

function PurchaseCaptureFields({ form }: EntityEditorFieldsProps) {
  return (
    <>
      <EntityValueField<FieldValues, "vendor">
        form={form}
        name="vendorId"
        entity="vendor"
        label="Vendor"
        placeholder="Who was paid?"
        SearchProvider={WithVendorShortcodeSearch}
      />
      <UnifiedTextField
        form={form}
        name="orderId"
        label="Order #"
        placeholder="Vendor order / receipt #"
      />
      <UnifiedTextField
        form={form}
        name="displayLabel"
        label="Display label"
        placeholder="e.g. pocket hole jig + bits"
      />
      <PlainDateField form={form} name="date" label="Purchase date" />
      <NullableNumericField
        form={form}
        name="statedTotal"
        label="Stated total"
        placeholder="What the receipt says"
        step="0.01"
        prefix="$"
      />
      <UnifiedTextField
        form={form}
        name="notes"
        label="Notes"
        placeholder="Anything worth remembering"
      />
    </>
  );
}

function FinancialAccountFields({ form, record }: EntityEditorFieldsProps) {
  const kind = form.watch("kind");
  const creating = !record;
  return (
    <>
      <TextField form={form} name="name" label="Name" />
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
      <NullableTextareaField
        form={form}
        name="notes"
        label="Notes"
        placeholder="Optional evidence"
      />
    </>
  );
}

function FinancialTransactionFields({ form }: EntityEditorFieldsProps) {
  const transactionForm = z
    .custom<UseFormReturn<FinancialTransactionFormValues>>()
    .parse(form);
  return <FinancialTransactionFormFields form={transactionForm} />;
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
      <UnifiedTextField
        form={form}
        name="name"
        label="What do you want?"
        placeholder="e.g. Metal milling machine"
        focusOnMount
      />
      <NullableTextareaField
        form={form}
        name="notes"
        label="Notes"
        placeholder="Why it would be useful or fun, constraints, future project ideas…"
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
  | "wish:update:full";

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
} satisfies {
  [K in EntityEditorPresentationKey]: EntityEditorPresentation<
    PresentationEntityByKey[K]
  >;
};

export function getEntityEditorPresentation<E extends EditableEntity>(input: {
  entity: E;
  operation: EntityEditOperation;
  intent: string;
}): EntityEditorPresentation<E> {
  const key = `${input.entity}:${input.operation}:${input.intent}`;
  const presentation = Object.entries(presentations).find(
    ([candidate]) => candidate === key,
  )?.[1];
  return z
    .custom<EntityEditorPresentation<E>>(
      (candidate) => candidate !== undefined,
      `No entity editor presentation for ${key}`,
    )
    .parse(presentation);
}
