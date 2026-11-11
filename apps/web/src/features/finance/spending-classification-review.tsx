import { fieldValueOf } from "@cubby/schemas/field-envelope";
import type {
  ProductCategoryShortcode,
  SpendingCategoryShortcode,
  ExpenseShortcode,
} from "@cubby/schemas/identifiers";
import { productCategoryShortcode } from "@cubby/schemas/identifiers";
import {
  spendingCategoryMappingMode,
  vendorSpendingProfile,
  type VendorSpendingProfile,
} from "@cubby/schemas/spending-classification";
import type {
  SpendingClassificationReviewInput,
  SpendingClassificationReviewPreview,
} from "@cubby/schemas/spending-classification-review";
import { useQueryClient } from "@tanstack/react-query";
import { useMutation } from "@tanstack/react-query";
import { useId, useState } from "react";

import type { DetailRecordOf } from "~/entity/entity-detail/detail-record";
import { useEntityMetadata } from "~/entity/metadata";
import { buildRecordComboboxItem } from "~/entity/picker/combobox-builders";
import { EntityReferencePicker } from "~/entity/picker/entity-reference-picker";
import { Picker as RecordPicker } from "~/entity/picker/picker";
import { referenceEntitySearch } from "~/entity/picker/reference-entity-search";
import { SpendingCategoryLabel } from "~/entity/presentation/spending-category-label";
import { spendingClassification } from "~/integrations/tanstack-query/generated/domains/spendingClassification.gen";
import { formatCurrency } from "~/lib/number-format";
import type { ComboboxItem } from "~/ui/combobox/combobox-types";
import { Picker } from "~/ui/combobox/picker";
import type { PickerOption } from "~/ui/combobox/picker-option";
import { StaticTable } from "~/ui/data-table/static-table";
import { ErrorDisplay } from "~/ui/feedback/error-display";
import { Button } from "~/ui/primitives/button";
import { Description } from "~/ui/text/description";

const MAPPING_MODE_OPTIONS: readonly PickerOption[] = [
  { value: "inherit", label: "Use ancestor mapping" },
  { value: "mapped", label: "Map to spending category" },
  { value: "blocked", label: "Keep unresolved" },
];

const CategorySearch = referenceEntitySearch("productCategory");

/** The Vendor declaration owns the profile choices and their labels. */
function SpendingProfilePicker({
  inputId,
  value,
  disabled,
  onValueChange,
}: {
  inputId: string;
  value: VendorSpendingProfile;
  disabled: boolean;
  onValueChange: (value: VendorSpendingProfile) => void;
}) {
  const options = (
    useEntityMetadata("vendor").fields.fields.find(
      (field) => field.key === "spendingProfile",
    )?.control?.options ?? []
  ).map(({ value: option, label }) => ({ value: option, label }));
  return (
    <Picker
      mode="choose"
      inputId={inputId}
      label="Merchant context"
      options={options}
      value={value}
      disabled={disabled}
      onValueChange={(next) => onValueChange(vendorSpendingProfile.parse(next))}
    />
  );
}

function ClassificationReview({
  initial,
  initialCategory,
  initialParent,
}: {
  initial: SpendingClassificationReviewInput;
  initialCategory?: ComboboxItem<SpendingCategoryShortcode> | null;
  initialParent?: ComboboxItem<ProductCategoryShortcode> | null;
}) {
  const mappingId = useId();
  const profileId = useId();
  const [request, setRequest] = useState(initial);
  const [parent, setParent] = useState(initialParent ?? null);
  const [category, setCategory] =
    useState<ComboboxItem<SpendingCategoryShortcode> | null>(() => {
      if (initialCategory !== undefined) return initialCategory;
      const id =
        initial.action === "products" ||
        initial.action === "spendingCategoryMerge"
          ? null
          : initial.action === "vendor"
            ? initial.defaultSpendingCategoryId
            : initial.spendingCategoryId;
      return id ? { id, name: id } : null;
    });
  const [review, setReview] =
    useState<SpendingClassificationReviewPreview | null>(null);
  const preview = useMutation({
    mutationFn: (input: SpendingClassificationReviewInput) =>
      spendingClassification.preview.call({ request: input }),
  });
  const apply = useMutation(spendingClassification.apply.mutationOptions());
  const busy = preview.isPending || apply.isPending;
  const setDraft = (next: SpendingClassificationReviewInput) => {
    setRequest(next);
    setReview(null);
    apply.reset();
  };
  return (
    <div className="max-w-2xl space-y-4">
      <p className="text-sm text-muted-foreground">
        {request.action === "expenses"
          ? "Remove the selected lines' saved spending categories and resolve them again from item detail and eligible defaults. Recorded money stays unchanged."
          : request.action === "spendingCategoryMerge"
            ? "Every Expense, Purchase, transaction, merchant default, and Product Category mapping in the merged categories moves to the kept category, including past spending."
            : "Defaults update past and future Expenses. Explicit Expense categories stay in place."}{" "}
        Review the change before applying it.
      </p>
      {request.action === "productCategory" && (
        <div className="space-y-1 text-sm">
          <span>Product category mapping</span>
          <Picker
            mode="choose"
            inputId={mappingId}
            label="Product category mapping"
            options={MAPPING_MODE_OPTIONS}
            value={request.spendingCategoryMode}
            disabled={busy}
            onValueChange={(next) => {
              const mode = spendingCategoryMappingMode.parse(next);
              setDraft({
                ...request,
                spendingCategoryMode: mode,
                spendingCategoryId:
                  mode === "mapped"
                    ? (category?.id ?? request.spendingCategoryId)
                    : null,
              });
            }}
          />
        </div>
      )}
      {request.action === "productCategory" && (
        <div className="space-y-1 text-sm">
          <span>Parent category</span>
          <CategorySearch>
            {({ items, ...search }) => (
              <RecordPicker
                {...search}
                entity="productCategory"
                items={items}
                label="Parent category"
                value={parent}
                disabled={busy}
                clearable
                placeholder="Root category"
                setValue={(item) => {
                  const parentId = item
                    ? productCategoryShortcode.parse(item.id)
                    : null;
                  setParent(
                    item && parentId ? { ...item, id: parentId } : null,
                  );
                  setDraft({ ...request, parentId });
                }}
              />
            )}
          </CategorySearch>
        </div>
      )}
      {request.action === "vendor" && (
        <div className="space-y-1 text-sm">
          <span>Merchant context</span>
          <SpendingProfilePicker
            inputId={profileId}
            value={request.spendingProfile}
            disabled={busy}
            onValueChange={(spendingProfile) =>
              setDraft({ ...request, spendingProfile })
            }
          />
        </div>
      )}
      {request.action !== "products" &&
        request.action !== "expenses" &&
        request.action !== "spendingCategoryMerge" &&
        (request.action !== "productCategory" ||
          request.spendingCategoryMode === "mapped") && (
          <EntityReferencePicker
            entity="spendingCategory"
            label="Spending category"
            value={category}
            disabled={busy}
            placeholder="Choose spending category"
            setValue={(item) => {
              setCategory(item);
              setDraft(
                request.action === "vendor"
                  ? { ...request, defaultSpendingCategoryId: item?.id ?? null }
                  : { ...request, spendingCategoryId: item?.id ?? null },
              );
            }}
          />
        )}
      <Button
        variant="outline"
        disabled={
          busy ||
          (request.action === "productCategory" &&
            request.spendingCategoryMode === "mapped" &&
            request.spendingCategoryId === null)
        }
        onClick={() => preview.mutate(request, { onSuccess: setReview })}
      >
        Preview historical impact
      </Button>
      {preview.error && <ErrorDisplay error={preview.error} />}
      {review && (
        <div className="space-y-3 border-t pt-4" aria-live="polite">
          {request.action === "productCategory" &&
            request.parentId !== undefined && (
              <Description>
                Requested parent:{" "}
                {request.parentId === null
                  ? "Root category"
                  : (parent?.name ?? request.parentId)}
                . This move applies with the reviewed mapping.
              </Description>
            )}
          <p className="text-sm">
            {review.changedExpenseCount} of {review.expenseCount} Expenses
            change classification. Uncategorized or incomplete:{" "}
            {review.beforeUncategorizedExpenseCount} →{" "}
            {review.afterUncategorizedExpenseCount}.{" "}
            {review.unpricedExpenseCount > 0 &&
              `${review.unpricedExpenseCount} unpriced Expenses are excluded from dollar totals.`}
          </p>
          <Description size="xs">
            All history, including planned. Expense totals stay the same.
          </Description>
          <StaticTable
            rows={review.categoryDeltas.filter((row) => row.deltaCents !== "0")}
            rowKey={(row) => row.spendingCategoryId ?? "unknown"}
            className="text-sm"
            columns={[
              {
                id: "category",
                header: "Category",
                cell: (row) =>
                  row.spendingCategoryId ? (
                    <SpendingCategoryLabel
                      id={row.spendingCategoryId}
                      name={row.spendingCategoryName}
                    />
                  ) : (
                    <span className="text-muted-foreground">Uncategorized</span>
                  ),
              },
              {
                id: "before",
                header: "Before",
                headClassName: "text-right",
                cellClassName: "text-right tabular-nums",
                cell: (row) => formatCurrency(Number(row.beforeCents) / 100),
              },
              {
                id: "delta",
                header: "Change",
                headClassName: "text-right",
                cellClassName: "text-right tabular-nums",
                cell: (row) => formatCurrency(Number(row.deltaCents) / 100),
              },
              {
                id: "after",
                header: "After",
                headClassName: "text-right",
                cellClassName: "text-right tabular-nums",
                cell: (row) => formatCurrency(Number(row.afterCents) / 100),
              },
            ]}
          />
          {review.categoryDeltas.every((row) => row.deltaCents === "0") && (
            <Description>No category dollar totals change.</Description>
          )}
          <Button
            disabled={busy || apply.isSuccess}
            onClick={() =>
              apply.mutate({
                request: review.request,
                fingerprint: review.fingerprint,
              })
            }
          >
            {apply.isSuccess ? "Applied" : "Apply reviewed change"}
          </Button>
          {apply.error && <ErrorDisplay error={apply.error} />}
        </div>
      )}
    </div>
  );
}

export function ProductCategoryClassification({
  record,
}: {
  record: ProductCategoryOut;
}) {
  const queryClient = useQueryClient();
  useEntityMetadata("spendingCategory");
  const effectiveRecordSpendingCategoryId = fieldValueOf(
    record.fields.spendingCategoryId,
  );

  return (
    <ClassificationReview
      key={record.id}
      initialParent={
        record.parentId
          ? {
              id: record.parentId,
              name: fieldValueOf(record.fields.parentName) ?? "Parent category",
            }
          : null
      }
      initialCategory={
        effectiveRecordSpendingCategoryId
          ? buildRecordComboboxItem(queryClient, "spendingCategory", {
              id: effectiveRecordSpendingCategoryId,
              name: record.spendingCategoryName,
              emoji: record.spendingCategoryEmoji,
            })
          : null
      }
      initial={{
        // Only the parent picker adds parentId; mapping edits must not restore stale topology.
        action: "productCategory",
        productCategoryId: record.id,
        spendingCategoryMode: record.spendingCategoryMode,
        spendingCategoryId:
          record.spendingCategoryMode === "mapped"
            ? effectiveRecordSpendingCategoryId
            : null,
      }}
    />
  );
}

/** Reset only the member-selected lines; uncertain saved intent stays intact. */
export function ExpenseItemDetailReview({
  expenseIds,
}: {
  expenseIds: ExpenseShortcode[];
}) {
  return (
    <ClassificationReview
      initial={{ action: "expenses", expenseIds, spendingCategoryId: null }}
    />
  );
}
/** A spending category merge moves history, so it applies only through review. */
export function SpendingCategoryMergeReview({
  keepId,
  mergeIds,
}: {
  keepId: SpendingCategoryShortcode;
  mergeIds: SpendingCategoryShortcode[];
}) {
  return (
    <ClassificationReview
      initial={{ action: "spendingCategoryMerge", keepId, mergeIds }}
    />
  );
}
export function VendorClassification({ record }: { record: VendorOut }) {
  const queryClient = useQueryClient();
  useEntityMetadata("spendingCategory");
  const effectiveRecordDefaultSpendingCategoryId = fieldValueOf(
    record.fields.defaultSpendingCategoryId,
  );
  const effectiveRecordSpendingProfile = fieldValueOf(
    record.fields.spendingProfile,
  );

  return (
    <ClassificationReview
      initialCategory={
        effectiveRecordDefaultSpendingCategoryId
          ? buildRecordComboboxItem(queryClient, "spendingCategory", {
              id: effectiveRecordDefaultSpendingCategoryId,
              name: record.defaultSpendingCategoryName,
              emoji: record.defaultSpendingCategoryEmoji,
            })
          : null
      }
      initial={{
        action: "vendor",
        vendorId: record.id,
        spendingProfile: effectiveRecordSpendingProfile ?? "unspecified",
        defaultSpendingCategoryId: effectiveRecordDefaultSpendingCategoryId,
      }}
    />
  );
}

type ProductCategoryOut = DetailRecordOf<"productCategory">;
type VendorOut = DetailRecordOf<"vendor">;
