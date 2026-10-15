import type { SpendingCategoryShortcode } from "@cubby/schemas/identifiers";
import type { ProductCategoryOut } from "@cubby/schemas/product-category";
import {
  spendingCategoryMappingMode,
  vendorSpendingProfile,
} from "@cubby/schemas/spending-classification";
import type {
  SpendingClassificationReviewInput,
  SpendingClassificationReviewPreview,
} from "@cubby/schemas/spending-classification-review";
import type { VendorOut } from "@cubby/schemas/vendor";
import { useMutation } from "@tanstack/react-query";
import { useId, useState } from "react";

import { buildRecordComboboxItem } from "~/entity/picker/combobox-builders";
import { EntityReferencePicker } from "~/entity/picker/entity-reference-picker";
import { spendingClassification } from "~/integrations/tanstack-query/generated/catalog.gen";
import { formatCurrency } from "~/lib/number-format";
import type { ComboboxItem } from "~/ui/combobox/combobox-types";
import { Picker } from "~/ui/combobox/picker";
import type { PickerOption } from "~/ui/combobox/picker-option";
import { ErrorDisplay } from "~/ui/feedback/error-display";
import { Button } from "~/ui/primitives/button";
import { StaticTable } from "~/ui/primitives/static-table";

const MAPPING_MODE_OPTIONS: readonly PickerOption[] = [
  { value: "inherit", label: "Use ancestor mapping" },
  { value: "mapped", label: "Map to spending category" },
  { value: "blocked", label: "Keep unresolved" },
];

const SPENDING_PROFILE_OPTIONS: readonly PickerOption[] = [
  { value: "unspecified", label: "Unspecified" },
  { value: "mixed_retail", label: "Mixed retailer" },
  { value: "food_retail", label: "Grocery / food retail" },
  { value: "restaurant", label: "Restaurant" },
  { value: "coffee_shop", label: "Coffee shop" },
];

function ClassificationReview({
  initial,
  initialCategory,
}: {
  initial: SpendingClassificationReviewInput;
  initialCategory?: ComboboxItem<SpendingCategoryShortcode> | null;
}) {
  const mappingId = useId();
  const profileId = useId();
  const [request, setRequest] = useState(initial);
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
        {request.action === "spendingCategoryMerge"
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
      {request.action === "vendor" && (
        <div className="space-y-1 text-sm">
          <span>Merchant context</span>
          <Picker
            mode="choose"
            inputId={profileId}
            label="Merchant context"
            options={SPENDING_PROFILE_OPTIONS}
            value={request.spendingProfile}
            disabled={busy}
            onValueChange={(next) =>
              setDraft({
                ...request,
                spendingProfile: vendorSpendingProfile.parse(next),
              })
            }
          />
        </div>
      )}
      {request.action !== "products" &&
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
          <p className="text-sm">
            {review.changedExpenseCount} of {review.expenseCount} Expenses
            change classification. Unclassified:{" "}
            {review.beforeUncategorizedExpenseCount} →{" "}
            {review.afterUncategorizedExpenseCount}.{" "}
            {review.unpricedExpenseCount > 0 &&
              `${review.unpricedExpenseCount} unpriced Expenses are excluded from dollar totals.`}
          </p>
          <p className="text-xs text-muted-foreground">
            Amounts include recorded and planned Expenses. Expense totals stay
            the same.
          </p>
          <StaticTable
            rows={review.categoryDeltas}
            rowKey={(row) => row.spendingCategoryId ?? "unknown"}
            className="text-sm"
            columns={[
              {
                id: "category",
                header: "Category",
                cell: (row) => row.spendingCategoryName ?? "Unclassified",
              },
              {
                id: "before",
                header: "Before",
                headClassName: "text-right",
                cellClassName: "text-right tabular-nums",
                cell: (row) => formatCurrency(Number(row.beforeCents) / 100),
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
  return (
    <ClassificationReview
      initialCategory={
        record.spendingCategoryId
          ? buildRecordComboboxItem("spendingCategory", {
              id: record.spendingCategoryId,
              name: record.spendingCategoryName,
              emoji: record.spendingCategoryEmoji,
            })
          : null
      }
      initial={{
        action: "productCategory",
        productCategoryId: record.id,
        spendingCategoryMode: record.spendingCategoryMode,
        spendingCategoryId: record.spendingCategoryId,
      }}
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
  return (
    <ClassificationReview
      initialCategory={
        record.defaultSpendingCategoryId
          ? buildRecordComboboxItem("spendingCategory", {
              id: record.defaultSpendingCategoryId,
              name: record.defaultSpendingCategoryName,
              emoji: record.defaultSpendingCategoryEmoji,
            })
          : null
      }
      initial={{
        action: "vendor",
        vendorId: record.id,
        spendingProfile: record.spendingProfile,
        defaultSpendingCategoryId: record.defaultSpendingCategoryId,
      }}
    />
  );
}
