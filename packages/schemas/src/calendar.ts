import { expenseBeneficiaryResult } from "./expense-beneficiaries";
import { fieldResolutionsSchema } from "./field-resolution";
import { withFieldEnvelopes } from "./field-envelope";
import {
  mealFieldEnvelopeFields,
  mealPublicReadFields,
} from "./generated/entity-field-envelope-fields.meal.gen";
import {
  taskFieldEnvelopeFields,
  taskPublicReadFields,
} from "./generated/entity-field-envelope-fields.task.gen";
import {
  expenseFieldEnvelopeFields,
  expensePublicReadFields,
} from "./generated/entity-field-envelope-fields.expense.gen";
import {
  projectFieldEnvelopeFields,
  projectPublicReadFields,
} from "./generated/entity-field-envelope-fields.project.gen";
import { displayImagesField } from "./display-images";
import { storedDateRangeSchema } from "./date-range";
import { z } from "zod";
import { dataQuality } from "./data-quality";
import { money, moneyNullable } from "./money";
import {
  mealShortcode,
  plantingShortcode,
  projectShortcode,
  expenseShortcode,
  purchaseShortcode,
  taskShortcode,
  ledgerPartyShortcode,
} from "./identifiers";
import { mealFilterFields, type MealOut } from "./meal";
import { plantingFilterFields } from "./planting";
import { mealKindSchema, mealTypeSchema } from "./meal-classification";
import { nutritionTotals } from "./nutrition";
import { plantingOut } from "./planting";
import {
  plainDate,
  taskFilterFields,
  expenseFilterFields,
  type ExpenseOut,
  type TaskOut,
  projectFilterFields,
  projectKindSchema,
  projectStatusSchema,
  taskOut,
  taskStatusSchema,
  tradeSchema,
} from "./project";

export const MAX_CALENDAR_RANGE_DAYS = 366;
const MILLISECONDS_PER_DAY = 86_400_000;

function calendarRangeDays(value: {
  startDate: string;
  endDateExclusive: string;
}): number {
  return (
    (Date.parse(`${value.endDateExclusive}T00:00:00Z`) -
      Date.parse(`${value.startDate}T00:00:00Z`)) /
    MILLISECONDS_PER_DAY
  );
}

export const calendarItemKind = z.enum([
  "meal",
  "task",
  "expense",
  "purchase",
  "project",
  "planting",
]);
export type CalendarItemKind = z.infer<typeof calendarItemKind>;

/** A source may project more than one canonical entity kind. */
export const calendarSourceKind = z.enum([
  "meal",
  "task",
  "spending",
  "project",
  "planting",
]);
export type CalendarSourceKind = z.infer<typeof calendarSourceKind>;
export const calendarSourceEntity = (source: CalendarSourceKind) =>
  source === "spending" ? "expense" : source;

export const calendarInteraction = z.enum(["move", "read-only"]);

const calendarItemBase = {
  startDate: plainDate,
  endDateExclusive: plainDate,
};

/** Current source facts are distinct from the occurrence's layout coordinates. */
export const rawCalendarMealSource = z.object({
  id: mealShortcode,
  name: z.string().nullable(),
  date: plainDate,
  mealType: mealTypeSchema.nullable(),
  mealKind: mealKindSchema.nullable(),
  recipeNames: z.array(z.string()),
  dataQuality: dataQuality.optional(),
  displayImages: displayImagesField.default([]),
});
export const rawCalendarTaskSource = z.object({
  // Keep resolver provenance through occurrence assembly; public envelopes consume it.
  fieldResolutions: fieldResolutionsSchema.optional(),
  id: taskShortcode,
  trade: tradeSchema,
  displayImages: displayImagesField.default([]),
});
export const rawCalendarExpenseSource = z.object({
  // Keep resolver provenance through occurrence assembly; public envelopes consume it.
  fieldResolutions: fieldResolutionsSchema.optional(),
  id: expenseShortcode,
  trade: tradeSchema.nullable(),
  vendor: z.string().nullable(),
  displayImages: displayImagesField.default([]),
});
export const rawCalendarProjectSource = z.object({
  id: projectShortcode,
  kind: projectKindSchema.nullable(),
  displayImages: displayImagesField.default([]),
});
export const rawCalendarPurchaseSource = z.object({
  id: purchaseShortcode,
  displayImages: displayImagesField.default([]),
});
export const rawCalendarPlantingSource = z.object({
  id: plantingShortcode,
  displayImages: displayImagesField.default([]),
});
export const calendarMealSource = withFieldEnvelopes(
  rawCalendarMealSource,
  {
    mealType: mealFieldEnvelopeFields.mealType,
    mealKind: mealFieldEnvelopeFields.mealKind,
    recipeNames: mealFieldEnvelopeFields.recipeNames,
    dataQuality: mealFieldEnvelopeFields.dataQuality,
    displayImages: null,
  },
  mealPublicReadFields,
);
export const calendarTaskSource = withFieldEnvelopes(
  rawCalendarTaskSource,
  { trade: taskFieldEnvelopeFields.trade, displayImages: null },
  taskPublicReadFields,
);
export const calendarExpenseSource = withFieldEnvelopes(
  rawCalendarExpenseSource,
  {
    trade: expenseFieldEnvelopeFields.trade,
    vendor: expenseFieldEnvelopeFields.vendor,
    displayImages: null,
  },
  expensePublicReadFields,
);
export const calendarProjectSource = withFieldEnvelopes(
  rawCalendarProjectSource,
  { kind: projectFieldEnvelopeFields.kind, displayImages: null },
  projectPublicReadFields,
);
export const calendarPurchaseSource = withFieldEnvelopes(
  rawCalendarPurchaseSource,
  { displayImages: null },
);
export const calendarPlantingSource = withFieldEnvelopes(
  rawCalendarPlantingSource,
  { displayImages: null },
);

export const calendarMealItem = z.object({
  kind: z.literal("meal"),
  id: mealShortcode,
  title: z.string(),
  name: z.string().nullable(),
  ...calendarItemBase,
  interaction: z.literal("move"),
  sortOrder: z.number().int().nullable(),
  source: calendarMealSource,
  mealTotals: nutritionTotals,
});

export const calendarTaskItem = z.object({
  kind: z.literal("task"),
  id: taskShortcode,
  title: z.string(),
  ...calendarItemBase,
  interaction: z.literal("move"),
  /** Raw nullable task boundaries; start/end above are normalized for layout. */
  due: storedDateRangeSchema.nullable(),
  status: taskStatusSchema,
  source: calendarTaskSource,
  projectName: z.string().nullable(),
  assignedProjectName: z.string().nullable().optional(),
  subjectProductName: z.string().nullable(),
});

export const calendarBeneficiarySource = withFieldEnvelopes(
  z.object({
    id: expenseShortcode,
    name: z.string(),
    effectiveBeneficiaries: expenseBeneficiaryResult.shape.portions.nullable(),
  }),
  { effectiveBeneficiaries: null },
);

const calendarSpendingContext = z.object({
  beneficiarySources: z.array(calendarBeneficiarySource),
  projectNames: z.array(z.string()),
  parties: z.array(
    z.object({
      id: ledgerPartyShortcode,
      name: z.string(),
      inherited: z.boolean(),
    }),
  ),
});

export const calendarExpenseItem = z.object({
  kind: z.literal("expense"),
  id: expenseShortcode,
  title: z.string(),
  ...calendarItemBase,
  interaction: calendarInteraction,
  future: z.boolean(),
  cost: moneyNullable,
  source: calendarExpenseSource,
  projectName: z.string().nullable(),
  productName: z.string().nullable(),
  spendingContext: calendarSpendingContext.optional(),
});

export const calendarPurchaseItem = z.object({
  kind: z.literal("purchase"),
  source: calendarPurchaseSource,
  id: purchaseShortcode,
  title: z.string(),
  ...calendarItemBase,
  interaction: z.literal("read-only"),
  occurrence: z.enum(["original", "refund"]),
  cost: moneyNullable,
  ledgerAmount: money,
  vendor: z.string().nullable(),
  basis: z.enum(["stated_total", "expense_lines", "settlement", "unknown"]),
  dateBasis: z.string(),
  evidenceNote: z.string().optional(),
  spendingContext: calendarSpendingContext.optional(),
  lines: z.array(
    z.object({
      id: expenseShortcode,
      name: z.string(),
      cost: moneyNullable,
      productName: z.string().nullable(),
    }),
  ),
});

export const calendarProjectItem = z.object({
  kind: z.literal("project"),
  id: projectShortcode,
  title: z.string(),
  ...calendarItemBase,
  interaction: z.literal("read-only"),
  status: projectStatusSchema,
  source: calendarProjectSource,
});

/** A planting's lifecycle milestones, in the order they occur. Each populated
 * milestone date becomes its own read-only calendar item — see
 * `loadCalendarPlantings`/`mapPlantingItems` in repo/calendar-plantings.ts. */
export const calendarPlantingMilestone = z.enum([
  "sowed",
  "transplanted",
  "finished",
]);
export type CalendarPlantingMilestone = z.infer<
  typeof calendarPlantingMilestone
>;

/** Shared between the calendar UI's metadata line and the garden ICS feed's
 * event summary, so the two never name a milestone differently. */
export const CALENDAR_PLANTING_MILESTONE_LABELS = {
  sowed: "Sowed",
  transplanted: "Transplanted",
  finished: "Finished",
} satisfies Record<CalendarPlantingMilestone, string>;

export const calendarPlantingItem = z.object({
  kind: z.literal("planting"),
  source: calendarPlantingSource,
  id: plantingShortcode,
  milestone: calendarPlantingMilestone,
  title: z.string(),
  locationName: z.string().nullable(),
  plannedWindow: z.string().nullable(),
  ...calendarItemBase,
  interaction: z.literal("read-only"),
});

export const calendarItem = z.discriminatedUnion("kind", [
  calendarMealItem,
  calendarTaskItem,
  calendarExpenseItem,
  calendarPurchaseItem,
  calendarProjectItem,
  calendarPlantingItem,
]);
export type CalendarItem = z.infer<typeof calendarItem>;

/** Entity identity owns links/media; occurrence identity owns layout/selection. */
export const calendarItemKey = (item: CalendarItem): string => {
  const base = `${item.kind}:${item.id}`;
  if (item.kind === "purchase")
    return `${base}:${item.occurrence}:${item.startDate}`;
  if (item.kind === "planting") return `${base}:${item.milestone}`;
  return base;
};

/** Each source uses its ordinary list filter contract. Active source filters
 * intersect source membership: a task filter excludes non-task sources. */
const calendarListFilterFields = {
  searchQuery: z.string().trim().min(1).max(100).optional(),
  ids: z.array(z.string()).max(500).optional(),
};

export const calendarFilterFields = {
  kinds: z.array(calendarSourceKind).nonempty().optional(),
  filters: z
    .object({
      meal: z
        .object({ ...mealFilterFields, ...calendarListFilterFields })
        .strict()
        .optional(),
      task: z
        .object({ ...taskFilterFields, ...calendarListFilterFields })
        .strict()
        .optional(),
      spending: z
        .object({ ...expenseFilterFields, ...calendarListFilterFields })
        .strict()
        .optional(),
      project: z
        .object({ ...projectFilterFields, ...calendarListFilterFields })
        .strict()
        .optional(),
      planting: z
        .object({ ...plantingFilterFields, ...calendarListFilterFields })
        .strict()
        .optional(),
    })
    .strict()
    .optional(),
};

/** The combined calendar's declared sources and date projections. */
export const calendarSources = {
  meal: { dates: ["date"] },
  task: { dates: ["due"] },
  spending: { dates: ["date"] },
  project: { projection: "subtree-date-windows" },
  planting: { dates: ["season", "transplantedOn"] },
} as const satisfies {
  meal: { dates: readonly (keyof MealOut)[] };
  task: { dates: readonly (keyof TaskOut)[] };
  spending: { dates: readonly (keyof ExpenseOut)[] };
  project: { projection: "subtree-date-windows" };
  planting: { dates: readonly (keyof z.infer<typeof plantingOut>)[] };
};

export const calendarFiltersInput = z.object(calendarFilterFields).strict();
export type CalendarFiltersInput = z.infer<typeof calendarFiltersInput>;

export const calendarSourceMatches = (
  kind: CalendarSourceKind,
  input: CalendarFiltersInput,
): boolean =>
  (!input.kinds || input.kinds.includes(kind)) &&
  Object.entries(input.filters ?? {}).every(
    ([source, filters]) =>
      source === kind ||
      !filters ||
      !Object.entries(filters).some(
        ([key, value]) => value !== undefined && !key.startsWith("includeSub"),
      ),
  );

export const calendarWindowInput = z
  .object({
    startDate: plainDate,
    endDateExclusive: plainDate,
    kinds: calendarFilterFields.kinds,
  })
  .strict()
  .refine((value) => value.startDate < value.endDateExclusive, {
    message: "endDateExclusive must be after startDate",
    path: ["endDateExclusive"],
  })
  .refine((value) => calendarRangeDays(value) <= MAX_CALENDAR_RANGE_DAYS, {
    message: `calendar range cannot exceed ${MAX_CALENDAR_RANGE_DAYS} days`,
    path: ["endDateExclusive"],
  });
/** Web calendar queries additionally intersect the ordinary source filters. */
export const calendarRangeInput = calendarWindowInput.safeExtend({
  filters: calendarFilterFields.filters,
});
export type CalendarRangeInput = z.infer<typeof calendarRangeInput>;

export const calendarDaySummary = z.object({
  actualSpend: money,
  plannedSpend: money,
  mealTotals: nutritionTotals,
  taskCount: z.number().int(),
  expenseCount: z.number().int(),
  mealCount: z.number().int(),
  projectCount: z.number().int(),
  /** Every item (any kind, plantings included) whose span covers this day. */
  itemIds: z.array(z.string()),
});
export type CalendarDaySummary = z.infer<typeof calendarDaySummary>;

export const calendarRangeOut = z.object({
  items: z.array(calendarItem),
  days: z.record(plainDate, calendarDaySummary),
});
export type CalendarRangeOut = z.infer<typeof calendarRangeOut>;

/** Schedule is a two-kind read. It uses the calendar range and project/task
 * filters, while meal, expense, and project-only filters do not constrain its
 * rows. Fully undated Tasks and Plantings remain visible in every window. */
export const calendarScheduleOut = z.object({
  tasks: z.array(taskOut),
  plantings: z.array(plantingOut),
});
export type CalendarScheduleOut = z.infer<typeof calendarScheduleOut>;

export const calendarFeedOut = z.object({ token: z.string().nullable() });
export const calendarRotateFeedOut = z.object({ token: z.string() });

/**
 * A Calendar app password is intentionally separate from the bearer token used
 * by read-only subscriptions. The password itself is never readable after its
 * one-time creation response.
 */
export const calendarCredentialOut = z.object({
  configured: z.boolean(),
  username: z.string(),
  createdAt: z.iso.datetime().nullable(),
});
export type CalendarCredential = z.infer<typeof calendarCredentialOut>;

export const calendarRotateCredentialOut = z.object({
  username: z.string(),
  password: z.string(),
  createdAt: z.iso.datetime(),
});
export type CalendarRotateCredential = z.infer<
  typeof calendarRotateCredentialOut
>;

export const calendarRevokeCredentialOut = z.object({ revoked: z.boolean() });

const calendarFeedDocumentInspection = z.object({
  etag: z.string(),
  generatedAt: z.iso.datetime(),
  revision: z.number().int().nonnegative(),
  itemCount: z.number().int().nonnegative(),
  byteLength: z.number().int().nonnegative(),
});

export const calendarFeedInspectionOut = z.object({
  schemaVersion: z.literal(1),
  inspectedAt: z.iso.datetime(),
  runtime: z.literal("durable-object"),
  origin: z.url(),
  object: z.object({
    id: z.string().nullable(),
    jurisdiction: z.string().nullable(),
  }),
  tokenConfigured: z.boolean(),
  snapshot: z
    .object({
      revision: z.number().int().nonnegative(),
      generatedAt: z.iso.datetime().nullable(),
    })
    .nullable(),
  dirty: z
    .object({
      reason: z.string(),
      sequence: z.number().int().nonnegative(),
    })
    .nullable(),
  alarmAt: z.iso.datetime().nullable(),
  feeds: z.object({
    meals: calendarFeedDocumentInspection.nullable(),
    tasks: calendarFeedDocumentInspection.nullable(),
    all: calendarFeedDocumentInspection.nullable(),
  }),
  caldav: z
    .object({
      counts: z.object({
        tasks: z.number().int().nonnegative(),
        completedTasks: z.number().int().nonnegative(),
        meals: z.number().int().nonnegative(),
      }),
      uncertainWrites: z.array(
        z.object({
          collection: z.enum(["tasks", "completed-tasks", "meals"]),
          filename: z.string(),
          shortcode: z.string().nullable(),
          startedAt: z.iso.datetime(),
        }),
      ),
      refreshFailedAt: z.iso.datetime().nullable(),
      ready: z.boolean(),
    })
    .nullable()
    .optional(),
});
export type CalendarFeedInspection = z.infer<typeof calendarFeedInspectionOut>;
export type CalendarFeedDocumentInspection = z.infer<
  typeof calendarFeedDocumentInspection
>;

export const clearCalendarUncertainWriteInput = z.object({
  collection: z.enum(["tasks", "completed-tasks", "meals"]),
  filename: z.string().min(1),
});
