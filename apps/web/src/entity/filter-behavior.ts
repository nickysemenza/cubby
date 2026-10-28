import { taskStatusSchema } from "@cubby/schemas/task-fields";

import type { FilterPatch } from "~/entity/filters";
import { resolveDueRange } from "~/entity/presentation/task-options";
import { resolveDateRange } from "~/lib/date-range-presets";

interface ProductPurchaseDateRangeFilters {
  purchaseDateFrom?: string;
  purchaseDateTo?: string;
}

type ProductPurchaseDateFilters = FilterPatch &
  (
    | { purchaseDatePresenceFilter: "has" | "none" }
    | ProductPurchaseDateRangeFilters
  );

export const resolveProductPurchaseDateFilter = (
  preset: string | undefined,
): ProductPurchaseDateFilters => {
  if (preset === "has" || preset === "none") {
    return { purchaseDatePresenceFilter: preset };
  }
  const { dateFrom, dateTo } = resolveDateRange(preset);
  const filters: FilterPatch & ProductPurchaseDateRangeFilters = {};
  if (dateFrom) filters.purchaseDateFrom = dateFrom;
  if (dateTo) filters.purchaseDateTo = dateTo;
  return filters;
};

export const resolveExpenseCount = (value: string | undefined) =>
  value === "has" || value === "none"
    ? { expensePresenceFilter: value }
    : value
      ? { expenseCountMin: Number(value) }
      : {};

export const resolveVendorPurchases = (value: string | undefined) =>
  value === "none"
    ? { purchaseCountMax: 0 }
    : value === "has"
      ? { purchaseCountMin: 1 }
      : value
        ? { purchaseCountMin: Number(value) }
        : {};

export const resolveLatestPurchaseDate = (preset: string | undefined) => {
  if (preset === "has" || preset === "none") {
    return { latestPurchaseDatePresenceFilter: preset };
  }
  const { dateFrom, dateTo } = resolveDateRange(preset);
  return {
    latestPurchaseDateFrom: dateFrom,
    latestPurchaseDateTo: dateTo,
  };
};

export const resolveVerifiedDate = (preset: string | undefined) => {
  if (preset === "has" || preset === "none") {
    return { verifiedPresenceFilter: preset };
  }
  const { dateFrom, dateTo } = resolveDateRange(preset);
  return { verifiedFrom: dateFrom, verifiedTo: dateTo };
};

export const resolveProductTaskFilter = (value: string | undefined) => {
  if (value === "has" || value === "none") {
    return { taskPresenceFilter: value };
  }
  // Open is every status but done, so it unions with a picked status.
  if (value === "open")
    return {
      taskStatusFilter: taskStatusSchema.options.filter(
        (status) => status !== "done",
      ),
    };
  if (taskStatusSchema.safeParse(value).success) {
    return { taskStatusFilter: value };
  }
  const { dueFrom, dueTo } = resolveDueRange(value);
  return { taskDueFrom: dueFrom, taskDueTo: dueTo };
};

export const resolveTaskDueFilter = (value: string | undefined) => {
  if (value === "has" || value === "none") {
    return { duePresenceFilter: value };
  }
  return resolveDueRange(value);
};

export const resolvePostedDate = (preset: string | undefined) => {
  const { dateFrom, dateTo } = resolveDateRange(preset);
  return { postedDateFrom: dateFrom, postedDateTo: dateTo };
};

export const resolveCreatedDate = (preset: string | undefined) => {
  const { dateFrom, dateTo } = resolveDateRange(preset);
  return { createdFrom: dateFrom, createdTo: dateTo };
};

export const resolveUpdatedDate = (preset: string | undefined) => {
  const { dateFrom, dateTo } = resolveDateRange(preset);
  return { updatedFrom: dateFrom, updatedTo: dateTo };
};
