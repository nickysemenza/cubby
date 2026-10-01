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

import type { ComboboxItem } from "~/app/_components/combobox/combobox-types";
import { EntityReferencePicker } from "~/app/_components/combobox/entity-reference-picker";
import { ErrorDisplay } from "~/components/feedback/error-display";
import { Button } from "~/components/ui/button";
import { StaticTable } from "~/components/ui/static-table";
import { NativeSelect } from "~/components/ui/native-select";
import { spendingClassification } from "~/integrations/tanstack-query/generated/catalog.gen";
import { formatCurrency } from "~/lib/utils";

function ClassificationReview({
  initial,
}: {
  initial: SpendingClassificationReviewInput;
}) {
  const mappingId = useId();
  const profileId = useId();
  const [request, setRequest] = useState(initial);
  const [category, setCategory] =
    useState<ComboboxItem<SpendingCategoryShortcode> | null>(() => {
      const id =
        initial.action === "products"
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
        Defaults update past and future Expenses. Explicit Expense categories
        stay in place. Review the change before applying it.
      </p>
      {request.action === "productCategory" && (
        <label htmlFor={mappingId} className="block space-y-1 text-sm">
          Product category mapping
          <NativeSelect
            id={mappingId}
            value={request.spendingCategoryMode}
            disabled={busy}
            onChange={(event) => {
              const mode = spendingCategoryMappingMode.parse(
                event.target.value,
              );
              setDraft({
                ...request,
                spendingCategoryMode: mode,
                spendingCategoryId:
                  mode === "mapped"
                    ? (category?.id ?? request.spendingCategoryId)
                    : null,
              });
            }}
          >
            <option value="inherit">Use ancestor mapping</option>
            <option value="mapped">Map to spending category</option>
            <option value="blocked">Keep unresolved</option>
          </NativeSelect>
        </label>
      )}
      {request.action === "vendor" && (
        <label htmlFor={profileId} className="block space-y-1 text-sm">
          Merchant context
          <NativeSelect
            id={profileId}
            value={request.spendingProfile}
            disabled={busy}
            onChange={(event) =>
              setDraft({
                ...request,
                spendingProfile: vendorSpendingProfile.parse(
                  event.target.value,
                ),
              })
            }
          >
            <option value="unspecified">Unspecified</option>
            <option value="mixed_retail">Mixed retailer</option>
            <option value="food_retail">Grocery / food retail</option>
            <option value="restaurant">Restaurant</option>
            <option value="coffee_shop">Coffee shop</option>
          </NativeSelect>
        </label>
      )}
      {request.action !== "products" &&
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
      initial={{
        action: "productCategory",
        productCategoryId: record.id,
        spendingCategoryMode: record.spendingCategoryMode,
        spendingCategoryId: record.spendingCategoryId,
      }}
    />
  );
}
export function VendorClassification({ record }: { record: VendorOut }) {
  return (
    <ClassificationReview
      initial={{
        action: "vendor",
        vendorId: record.id,
        spendingProfile: record.spendingProfile,
        defaultSpendingCategoryId: record.defaultSpendingCategoryId,
      }}
    />
  );
}
