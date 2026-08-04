import { expenseLineKindSchema } from "@cubby/schemas/expense-line-kind";
import type {
  ProductShortcode,
  ProjectShortcode,
} from "@cubby/schemas/identifiers";
import { unsafeProjectShortcode } from "@cubby/schemas/identifiers";
import { costTypeSchema, plainDate, tradeSchema } from "@cubby/schemas/project";
import { format } from "date-fns";
import { useMemo } from "react";
import { Controller } from "react-hook-form";
import { z } from "zod";
import { WithProjectSearch } from "~/app/_components/combobox/with-search-hook";
import { EntityValueField } from "~/app/_components/form-utils/entity-value-field";
import { QuickAddDialog } from "~/app/_components/forms/quick-add-dialog";
import { tradeOptions } from "~/app/projects/shared";
import { Row } from "~/components/layout";
import { Description } from "~/components/ui/description";
import { Switch } from "~/components/ui/switch";
import { useTRPC } from "~/integrations/trpc/react";
import { expenseMutationInvalidateKeys } from "~/lib/query-keys";
import {
  NullableNumericField,
  PlainDateField,
  SelectField,
  UnifiedTextField,
} from "../_components/form-utils";
import { VendorField } from "../_components/form-utils/vendor-field";
import { FormFieldGroup } from "../_components/forms/form-field-group";
import { costTypeOptions, expenseLineKindOptions } from "./expense-options";

const today = () => format(new Date(), "yyyy-MM-dd");

// projectId stays a plain string here (not the branded `projectId` schema) —
// it's the raw value out of the `SelectField` dropdown; the ProjectShortcode
// brand is applied at the tRPC-call boundary in buildPayload via
// `unsafeProjectShortcode` — a project is named by its public code now.
// `name` is the only truly required field — `trade`/`costType` now default
// (see `defaultValues` below) rather than forcing a choice via `.refine()`.
const quickAddExpenseSchema = z.object({
  name: z.string().min(1, "Name is required"),
  lineKind: z.union([z.literal("auto"), expenseLineKindSchema]),
  cost: z.number().nullable(),
  date: plainDate,
  projectId: z.string().nullable(),
  costType: costTypeSchema,
  trade: tradeSchema,
  future: z.boolean(),
  // Signed, never zero — a negative quantity on a $0 line is a discard.
  productQuantity: z
    .number()
    .int()
    .refine((value) => value !== 0, "Quantity cannot be zero")
    .nullable(),
  vendor: z.string(),
  orderId: z.string(),
});
type QuickAddExpenseValues = z.infer<typeof quickAddExpenseSchema>;

interface CreateExpenseDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Pre-fill the project from a project detail page's "New expense" button.
   * Read once, on mount — the caller conditionally mounts a fresh dialog
   * instance per click (see `CreateTaskDialog`'s `presetProjectId`).
   */
  presetProjectId?: ProjectShortcode | null;
  /**
   * Link the new expense to a product. Not a form field — there's no product
   * picker in quick-add; linking an existing expense happens via the Product
   * field on the expense detail page.
   */
  presetProductId?: ProductShortcode | null;
  presetDate?: string;
  presetFuture?: boolean;
  /**
   * `"disposition"` records a product leaving the collection rather than
   * arriving: a sale (negative cost), a return (negative full price), or a
   * broken/gifted item (cost 0). Only changes copy and defaults — the row is an
   * ordinary expense, which is the whole point of the convention.
   */
  intent?: "expense" | "disposition";
}

export function CreateExpenseDialog({
  open,
  onOpenChange,
  presetProjectId,
  presetProductId,
  presetDate,
  presetFuture,
  intent = "expense",
}: CreateExpenseDialogProps) {
  const api = useTRPC();
  const isDisposition = intent === "disposition";

  const defaultValues = useMemo<QuickAddExpenseValues>(
    () => ({
      name: "",
      lineKind: "auto",
      cost: null,
      date: presetDate ?? today(),
      // A disposition deliberately defaults to no project: a negative cost
      // attached to a project reduces its spend and inflates budgetRemaining,
      // so attaching one has to be a deliberate act.
      projectId: isDisposition ? null : (presetProjectId ?? null),
      // "other"/"materials" are the least-wrong defaults for a fresh quick
      // capture — most household expenses are an untriaged materials buy;
      // both are one click to correct via the row's inline-editable columns.
      costType: isDisposition ? "tools" : "materials",
      trade: "other",
      future: presetFuture ?? false,
      productQuantity: null,
      vendor: "",
      orderId: "",
    }),
    [presetDate, presetFuture, presetProjectId, isDisposition],
  );

  return (
    <QuickAddDialog
      open={open}
      onOpenChange={onOpenChange}
      schema={quickAddExpenseSchema}
      defaultValues={defaultValues}
      title={isDisposition ? "Record Sale or Disposal" : "New Expense"}
      description={
        isDisposition
          ? "Enter a negative cost for a sale or return, or 0 with a negative quantity if it broke or was given away. Ownership itself comes off inventory — remember to clear the entry too."
          : "Log what you bought (or plan to) — the fastest way to keep a project's cost honest."
      }
      mutationFn={api.expense.create.mutationOptions}
      successMessage={(expense) => `Logged "${expense.name}"`}
      invalidateKeys={expenseMutationInvalidateKeys}
      buildPayload={(values) => ({
        name: values.name,
        lineKind: values.lineKind === "auto" ? undefined : values.lineKind,
        cost: values.cost,
        date: values.date,
        projectId: values.projectId
          ? unsafeProjectShortcode(values.projectId)
          : null,
        productId: presetProductId ?? null,
        productQuantity: presetProductId ? values.productQuantity : null,
        vendor: values.vendor.trim() || null,
        orderId: values.orderId.trim() || null,
        costType: values.costType,
        trade: values.trade,
        url: null,
        notes: null,
        future: values.future,
      })}
    >
      {(form) => (
        <>
          <UnifiedTextField
            form={form}
            name="name"
            label="Name"
            placeholder="What did you buy?"
            autoFocus
          />
          {!presetProductId ? (
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
          {presetProductId ? (
            <>
              <NullableNumericField
                form={form}
                name="productQuantity"
                label="Product quantity"
                placeholder="Unknown"
                step="1"
              />
              {isDisposition ? (
                <Description>
                  On a $0 line the sign is the fact: a negative quantity records
                  a discard, a positive one a free acquisition. Use the Discard
                  action on the product to clear the shelf at the same time.
                </Description>
              ) : null}
            </>
          ) : null}
          <Controller
            control={form.control}
            name="future"
            render={({ field: futureField }) => (
              <>
                <FormFieldGroup label="Planned">
                  <Row align="center" gap="sm">
                    <Switch
                      checked={futureField.value}
                      onCheckedChange={futureField.onChange}
                    />
                    <span className="text-muted-foreground text-sm">
                      {futureField.value ? "Not bought yet" : "Already bought"}
                    </span>
                  </Row>
                </FormFieldGroup>
                <PlainDateField
                  form={form}
                  name="date"
                  label={futureField.value ? "Expected date" : "Expense date"}
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
          {/* Roster picker, not free text — see `VendorField`. A disposition's
              vendor is who you sold/gave the thing TO, so only the prompt
              changes. */}
          <VendorField
            form={form}
            name="vendor"
            label="Vendor"
            placeholder={isDisposition ? "Sold to / given to" : "Where from?"}
          />
          <UnifiedTextField
            form={form}
            name="orderId"
            label="Order #"
            placeholder="Vendor order #"
          />
          <EntityValueField<QuickAddExpenseValues, ProjectShortcode>
            form={form}
            name="projectId"
            entity="project"
            label="Project"
            SearchProvider={WithProjectSearch}
            clearable
          />
        </>
      )}
    </QuickAddDialog>
  );
}
