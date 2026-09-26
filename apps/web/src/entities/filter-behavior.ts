import { taskStatusSchema } from "@cubby/schemas/task-fields";

import { resolveDateRange } from "~/app/expenses/expense-options";
import { resolveDueRange } from "~/app/tasks/task-options";
import type { FilterPatch } from "~/entities/filters";

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

export const resolveNetBasis = (value: string | undefined) => {
  if (value === "positive") return { expenseTotalMin: 0.01 };
  if (value === "zero") return { expenseTotalMin: 0, expenseTotalMax: 0 };
  if (value === "negative") return { expenseTotalMax: -0.01 };
  if (value === "gte100") return { expenseTotalMin: 100 };
  if (value === "gte500") return { expenseTotalMin: 500 };
  return {};
};

export const resolvePrice = (value: string | undefined) => {
  if (value === "has" || value === "none") {
    return { pricePresenceFilter: value };
  }
  // `misc:` buckets have no meaningful unit price, so keep them separate from
  // real unpriced products instead of making that worklist permanently red.
  if (value === "none-real") {
    return {
      pricePresenceFilter: "none" as const,
      miscBucketFilter: "none" as const,
    };
  }
  if (value === "none-bucket") {
    return {
      pricePresenceFilter: "none" as const,
      miscBucketFilter: "has" as const,
    };
  }
  return {};
};

export const resolveExpectedQuantity = (value: string | undefined) => {
  if (value === "negative") return { expectedQuantityMax: -1 };
  if (value === "zero") {
    return { expectedQuantityMin: 0, expectedQuantityMax: 0 };
  }
  if (value === "positive") return { expectedQuantityMin: 1 };
  if (value === "gte5") return { expectedQuantityMin: 5 };
  if (value === "unknown") {
    return { unknownQuantityLinesFilter: "has" as const };
  }
  return {};
};

export const resolveQuantityVariance = (value: string | undefined) =>
  value === "mismatched" || value === "matched"
    ? { quantityVarianceFilter: value }
    : {};

export const resolveVendorPurchases = (value: string | undefined) =>
  value === "none"
    ? { purchaseCountMax: 0 }
    : value === "has"
      ? { purchaseCountMin: 1 }
      : value
        ? { purchaseCountMin: Number(value) }
        : {};

export const resolveVendorSpend = (value: string | undefined) => {
  if (value === "positive") return { spendMin: 0.01 };
  if (value === "zero") return { spendMin: 0, spendMax: 0 };
  if (value === "negative") return { spendMax: -0.01 };
  if (value === "gte100") return { spendMin: 100 };
  if (value === "gte500") return { spendMin: 500 };
  return {};
};

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
  if (value === "open") return { taskOpenOnly: true };
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

export const resolveRecountAge = (value: string | undefined) => {
  const days = Number(value);
  return Number.isInteger(days) && days > 0
    ? { lastBulkInventoryOlderThanDays: days }
    : {};
};

export const resolveLocationItems = (value: string | undefined) =>
  value === "none"
    ? { directItemCountMax: 0 }
    : value === "has"
      ? { directItemCountMin: 1 }
      : value
        ? { directItemCountMin: Number(value) }
        : {};

export const resolveLocationValuation = (value: string | undefined) => {
  if (value === "positive") return { valuationMin: 0.01 };
  if (value === "zero") return { valuationMin: 0, valuationMax: 0 };
  if (value === "negative") return { valuationMax: -0.01 };
  if (value === "gte100") return { valuationMin: 100 };
  if (value === "gte500") return { valuationMin: 500 };
  return {};
};

export const resolveRecipeCost = (value: string | undefined) =>
  value === "under10"
    ? { costTotalMax: 10 }
    : value === "10to25"
      ? { costTotalMin: 10, costTotalMax: 25 }
      : value === "25plus"
        ? { costTotalMin: 25 }
        : {};

export const resolveRecipeTotalTime = (value: string | undefined) =>
  value === "under30"
    ? { totalMinutesMax: 30 }
    : value === "30to60"
      ? { totalMinutesMin: 30, totalMinutesMax: 60 }
      : value === "60plus"
        ? { totalMinutesMin: 60 }
        : {};

export const resolveCalories = (value: string | undefined) =>
  value === "under500"
    ? { caloriesTotalMax: 500 }
    : value === "500to1000"
      ? { caloriesTotalMin: 500, caloriesTotalMax: 1000 }
      : value === "1000plus"
        ? { caloriesTotalMin: 1000 }
        : {};

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

export const resolveImageCreatedDate = (value: string | undefined) => {
  if (value === "olderThan1h") return { uploadedAgeHoursMin: 1 };
  return resolveCreatedDate(value);
};
