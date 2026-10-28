import { timestampField } from "./field-policy";
import { imageDescriptionInputs } from "./image-description-inputs";
import {
  historicalDateRangePresets,
  dateRangeSchema,
  storedDateRangeSchema,
} from "../date-range";
import { imageAssociationStorage } from "./image-associations";
import { recordEmojiField } from "../emoji";
import {
  type DerivedStoredInput,
  defineEntity,
  defineEntityModel,
} from "./definition.js";
import { selectControlOptions } from "./select-control-options.js";
import {
  ledgerPartyShortcode,
  projectShortcode,
} from "../identifier-fields.js";
import { positiveMoneyNullable } from "@cubby/schemas/money";
import {
  googleDriveFolderUrl,
  notionPageUrl,
  projectKindSchema,
  projectStatusSchema,
} from "@cubby/schemas/project-fields";
import {
  projectDateWindow,
  projectRollup,
  projectRollupResult,
} from "@cubby/schemas/project-output-fields";
import {
  MAX_PROJECT_TREE_DEPTH,
  HOUSEHOLD_PROJECT_SHORTCODE,
  projectStatusValues,
} from "../project-fields.js";
import { z } from "zod";
import { TRADE_SUGGEST_RULE, tradeSchema } from "@cubby/schemas/task-fields";

/** Rows a project's folded dates read (stored derived inputs, ADR 0021). */
const PROJECT_DATE_INPUTS: DerivedStoredInput[] = [
  {
    table: "Project",
    match: { id: "id" },
    columns: ["startDate", "endDate", "status", "parentProjectId", "deletedAt"],
  },
  {
    table: "Project",
    match: { parentProjectId: "id" },
    columns: ["startDate", "endDate", "status", "parentProjectId", "deletedAt"],
  },
  {
    table: "Task",
    match: { projectId: "id" },
    columns: [
      "dueDate",
      "dueEndDate",
      "status",
      "projectId",
      "projectMode",
      "deletedAt",
    ],
  },
  {
    table: "Expense",
    match: { projectId: "id" },
    columns: ["date", "projectId", "purchaseId", "deletedAt"],
  },
  {
    table: "Purchase",
    match: { defaultProjectId: "id" },
    columns: ["date", "defaultProjectId", "deletedAt"],
  },
  {
    table: "Product",
    match: { id: "id" },
    columns: ["categoryId", "deletedAt"],
    path: [{ table: "Expense", from: "productId", to: "projectId" }],
  },
  {
    table: "ProductCategory",
    match: { id: "id" },
    columns: ["feature", "parentId", "deletedAt"],
    path: [
      { table: "Product", from: "categoryId", to: "id" },
      { table: "Expense", from: "productId", to: "projectId" },
    ],
  },
  {
    table: "SpendingCategory",
    match: { id: "id" },
    columns: ["deletedAt"],
    path: [
      {
        table: "Expense",
        from: "spendingCategoryId",
        to: "projectId",
      },
    ],
  },
  // A subtask's effective project belongs to its parent, not its null projectId.
  {
    table: "Task",
    match: { parentTaskId: "id" },
    columns: [
      "dueDate",
      "dueEndDate",
      "status",
      "parentTaskId",
      "projectId",
      "projectMode",
      "deletedAt",
    ],
    path: [{ table: "Task", from: "id", to: "projectId" }],
  },
  {
    table: "Task",
    match: { id: "id" },
    columns: [
      "dueDate",
      "dueEndDate",
      "status",
      "parentTaskId",
      "projectId",
      "projectMode",
      "deletedAt",
    ],
    path: [
      { table: "Task", from: "id", to: "parentTaskId" },
      { table: "Task", from: "id", to: "projectId" },
    ],
  },
];
/** Allocations include complete Purchase siblings, defaults and food fallback. */
const PROJECT_ROLLUP_INPUTS: DerivedStoredInput[] = [
  ...PROJECT_DATE_INPUTS,
  {
    table: "Project",
    match: { id: "id" },
    columns: ["costEstimate", "deletedAt", "parentProjectId"],
  },
  {
    table: "Expense",
    match: { projectId: "id" },
    columns: [
      "cost",
      "future",
      "lineKind",
      "date",
      "purchaseId",
      "projectId",
      "productId",
      "deletedAt",
    ],
  },
  {
    table: "Expense",
    match: { purchaseId: "id" },
    path: [{ table: "Expense", from: "purchaseId", to: "projectId" }],
  },
  {
    table: "Expense",
    match: { purchaseId: "id" },
    path: [{ table: "Purchase", from: "id", to: "defaultProjectId" }],
  },
  {
    table: "Purchase",
    match: { id: "id" },
    path: [{ table: "Expense", from: "purchaseId", to: "projectId" }],
  },
  {
    table: "Project",
    match: { id: "id" },
    columns: ["deletedAt"],
    path: [
      { table: "Expense", from: "projectId", to: "purchaseId" },
      { table: "Expense", from: "purchaseId", to: "projectId" },
    ],
  },
  {
    table: "Project",
    match: { id: "id" },
    columns: ["deletedAt"],
    path: [
      { table: "Expense", from: "projectId", to: "purchaseId" },
      { table: "Purchase", from: "id", to: "defaultProjectId" },
    ],
  },
  {
    table: "Project",
    match: { id: "id" },
    columns: ["deletedAt"],
    path: [
      { table: "Purchase", from: "defaultProjectId", to: "id" },
      { table: "Expense", from: "purchaseId", to: "projectId" },
    ],
  },
  {
    table: "LedgerParty",
    match: { id: "id" },
    columns: ["name", "kind", "deletedAt"],
    path: [{ table: "Project", from: "assigneeId", to: "id" }],
  },
  // Food fallback has a fixed canonical target even when every source FK is null.
  ...["Expense", "Purchase", "Product", "ProductCategory"].map((table) => ({
    table,
    match: { id: "id" },
    targetWhere: { shortcode: HOUSEHOLD_PROJECT_SHORTCODE },
  })),
  {
    table: "Project",
    match: { id: "id" },
    columns: ["deletedAt", "shortcode"],
    targetWhere: { shortcode: HOUSEHOLD_PROJECT_SHORTCODE },
  },
];
const inheritanceModeSchema = z.enum(["inherit", "explicit"]);
export const { definition, readSchemas } = defineEntityModel({
  key: "project",
  names: { singular: "Project", plural: "Projects" },
  route: { basePath: "projects" },
  table: "Project",
  identifiers: { brand: "ProjectId", shortcode: "PRJ-" },
  presentation: {
    edit: {
      sections: [
        {
          id: "defaults",
          title: "Defaults",
          fields: ["locations", "assigneeId", "defaultTrade"],
        },
        {
          id: "budget",
          title: "Budget",
          fields: ["costEstimate"],
        },
        {
          id: "schedule",
          title: "Schedule",
          fields: ["dates"],
        },
        {
          id: "details",
          title: "Details",
          fields: ["notes", "googleDriveFolderUrl", "notionPageUrl"],
        },
      ],
    },
    recordEmojiField: "emoji",
    titleField: "name",
    domain: "house",
    description: "Household work grouped into durable projects.",
    emptyState: {
      title: "No projects yet",
      description:
        "Track household projects from planning to done \u2014 budget, timeline, and every task and expense along the way.",
      actionLabel: "New Project",
    },
    icons: { phosphor: "Hammer", sfSymbol: "hammer", emoji: "🛠️" },
    detail: {
      summary: [
        {
          kind: "fields",
          id: "progress-dates",
          title: "Progress & dates",
          fields: ["status", "taskProgress", "dates"],
        },
        {
          kind: "records",
          id: "tasks",
          title: "Tasks",
          viewKey: "relation:tasks",
        },
        {
          kind: "records",
          id: "blockers",
          title: "Blockers",
          viewKey: "relation:blocked-by",
        },
        {
          kind: "report",
          id: "budget-coverage",
          title: "Budget & coverage",
          slot: "project.budget",
        },
        {
          kind: "fields",
          id: "places-assignee",
          title: "Places & assignee",
          fields: ["locations", "assigneeId"],
        },
        {
          kind: "records",
          id: "sub-projects",
          title: "Sub-projects",
          viewKey: "relation:sub-projects",
        },
        {
          kind: "records",
          id: "purchased-products",
          title: "Purchased Products",
          viewKey: "relation:purchased-products",
        },
        {
          kind: "chart",
          id: "monthly-spend",
          title: "Spend over 12 months",
          viewKey: "relation:expenses",
        },
      ],

      activityRelations: [
        { relation: "purchases", dateField: "date" },
        { relation: "defaultPurchases", dateField: "date" },
        { relation: "tasks", dateField: "dueDate" },
        { relation: "expenses", dateField: "date" },
        { relation: "images", dateField: "capturedAt" },
      ],
      relationFilterOverrides: {
        purchases: { descriptor: "related:purchase.projects" },
        "purchased-products": { descriptor: "related:product.projects" },
        resources: { descriptor: "usedOnProjectId" },
      },
      omitRelations: {
        "blocked-by":
          "The Dependencies section edits Blocked by and Blocking in place.",
        "task-products":
          "The Tasks table shows each task's subject product; Resources and Purchased products cover the rest.",
        defaultPurchases:
          "A subset of the Purchases table; each purchase shows its default project as a field.",
      },
      hero: {
        chip: "status",

        extraActions: ["setStatus"],
      },
      sections: [
        {
          kind: "relation",
          id: "tasks",
          title: "Tasks",
          relation: "tasks",
          filter: { descriptor: "projectId" },
          groupBy: "status",
          sort: { field: "dueDate", direction: "desc" },
        },
        {
          kind: "fields",
          id: "overview",
          title: "Record",
          fields: ["emoji", "name", "status", "kind", "parentProjectId"],
        },
        {
          kind: "fields",
          id: "notes",
          title: "Notes",
          fields: ["notes"],
        },
        {
          kind: "slot",
          id: "schedule",
          title: "Schedule",
          placement: "full",
        },
        {
          kind: "fields",
          id: "schedule-dates",
          title: "Schedule",
          fields: ["dates"],
        },
        { kind: "slot", id: "budget", title: "Budget" },
        {
          kind: "fields",
          id: "budget-estimate",
          title: "Budget",
          fields: ["costEstimate"],
        },
        {
          kind: "fields",
          id: "dependencies",
          title: "Dependencies",
          fields: ["blockedByIds", "blockingIds"],
        },
        {
          kind: "fields",
          id: "defaults",
          title: "Defaults",
          fields: ["locations", "assigneeId", "defaultTrade"],
        },
        {
          kind: "fields",
          id: "resource-links",
          title: "Resources",
          fields: ["googleDriveFolderUrl", "notionPageUrl"],
        },
        {
          kind: "slot",
          id: "contribution",
          title: "Contribution",
        },
        {
          kind: "slot",
          id: "analytics",
          title: "Analytics",
          placement: "full",
        },
        {
          kind: "fields",
          id: "coverage",
          title: "Coverage and summaries",
          fields: ["updatedAt"],
        },
      ],
    },
    list: {
      savedViews: [
        {
          id: "active",
          label: "Active",
          description: "Projects that have not been completed",
          filters: [
            {
              id: "status",
              value: projectStatusValues.filter((status) => status !== "done"),
            },
          ],
        },
        {
          id: "completed",
          label: "Completed",
          description: "Finished projects, including sub-projects",
          filters: [{ id: "status", value: ["done"] }],
        },
      ],
      totals: [
        {
          id: "costEstimate",
          label: "Estimates",
          keys: ["costEstimate"],
          format: "currency",
        },
      ],
      views: [
        "table",
        {
          kind: "slot",
          id: "calendar",
          label: "Calendar",
          searchKeys: ["period", "calendarDate"],
        },
        {
          kind: "slot",
          id: "schedule",
          label: "Schedule",
          searchKeys: ["rows"],
        },
        {
          kind: "slot",
          id: "overview",
          label: "Overview",
          searchKeys: ["rows"],
        },
        { kind: "slot", id: "analytics", label: "Analytics" },
      ],
      viewAliases: { gallery: "shelf" },
      extraActions: ["setStatus"],
      links: [{ label: "Tools", path: "/tools" }],
    },
  },
  model: {
    hierarchy: {
      parentField: "parentProjectId",
      maxDepth: MAX_PROJECT_TREE_DEPTH,
    },
    fields: [
      {
        audit: false,
        ...recordEmojiField,
        control: {
          ...recordEmojiField.control,
          suggest: {
            ...recordEmojiField.control.suggest,
            basis: ["name", "notes", "kind"],
          },
        },
      },
      {
        key: "name",
        kind: "text",
        control: { kind: "text", placeholder: "What are you working on?" },
        display: { standard: "name" },
        validation: {
          read: z.string().min(1),
          create: z.string().min(1),
          update: z.string().min(1).optional(),
        },
      },
      {
        key: "status",
        kind: "enum",
        control: {
          kind: "select",
          options: selectControlOptions.projectStatus,
        },
        display: {
          columnGroup: "Plan",
          mobile: { slot: "subtitle", priority: 10 },
        },
        validation: {
          read: projectStatusSchema,
          create: projectStatusSchema.default("planning"),
          update: projectStatusSchema.optional(),
        },
      },
      {
        key: "kind",
        kind: "enum",
        nullable: true,
        control: {
          kind: "select",
          options: selectControlOptions.projectKind,
          suggest: {
            basis: ["name", "notes"],
            rules: [
              `You are a project classification assistant. Given a project name and notes, determine the most appropriate kind.

Rules:
1. Match the primary subject of the project, not incidental tasks within it.
2. Remodeling a room or structure is "renovation". Standalone home maintenance, repair, or replacement, such as replacing a ceiling light or furnace, is "household", even when the name mentions a room.
3. Building or restoring furniture is "furniture", except shop fixtures such as workbenches, jigs, and tool storage, which are "workshop".
4. Growing plants and caring for them is "garden". Permanent outdoor construction, including paving, retaining walls, and irrigation infrastructure, is "renovation".`,
            ],
          },
        },
        display: { columnGroup: "Plan" },
        validation: {
          read: projectKindSchema.nullable(),
          create: projectKindSchema.nullable().default(null),
          update: projectKindSchema.nullable().optional(),
        },
      },
      {
        key: "locations",
        kind: "text-array",
        collection: { key: "value" },
        control: { kind: "specialized", renderer: "tag-list" },
        display: { list: false },
        resolution: {
          reset: { locationsMode: "inherit", locations: [] },
          none: { locationsMode: "explicit", locations: [] },
          redundancy: "eligible",
          inherit: {
            mode: { field: "locationsMode", inherit: "inherit" },
            from: ["hierarchy"],
          },
        },
        explanation: {
          ruleId: "project.effective-locations",
          description:
            "Explicit project locations win; otherwise the nearest parent project with explicit locations supplies them.",
          projections: {
            list: "locations",
            detail: "locations",
            summary: "locations",
          },
          sourceDependencies: [
            {
              path: "fields.locations.result.decision.provenance.source",
              label: "Source",
            },
            {
              path: "fields.locations.current.assignment.value",
              label: "Stored override",
            },
            {
              path: "fields.locations.current.controls.reset.preview.result.decision.outcome.value",
              label: "Inherited value",
            },
          ],
        },
        validation: {
          read: z.array(z.string()).describe("House/site names, free-form"),
          create: z.array(z.string()).default([]),
          update: z.array(z.string()).optional(),
        },
      },
      {
        output: false,
        key: "locationsMode",
        kind: "enum",
        validation: {
          read: null,
          create: inheritanceModeSchema.optional(),
          update: inheritanceModeSchema.optional(),
        },
        display: {
          optionRole: "category",
          optionColor: "domain-house",
          optionGlyph: {
            phosphor: "ArrowBendDownRight",
            sfSymbol: "arrow.turn.down.right",
          },
          valueOptions: [
            { value: "inherit", label: "Inherit" },
            { value: "explicit", label: "Explicit" },
          ],
        },
      },
      {
        key: "assigneeId",
        labelOverride: "Default assignee",
        kind: "identifier",
        nullable: true,
        reference: {
          entity: "ledgerParty",
          filters: [{ field: "kind", values: ["member"] }],
        },
        control: { kind: "specialized", renderer: "entity-select" },
        display: {
          columnGroup: "Responsibility",
          columnLabel: "Assignee",
          width: "md",
          mobile: { slot: "meta", priority: 40, interactive: true },
        },
        resolution: {
          reset: { assigneeMode: "inherit", assigneeId: null },
          none: { assigneeMode: "explicit", assigneeId: null },
          redundancy: "eligible",
          inherit: {
            mode: { field: "assigneeMode", inherit: "inherit" },
            from: ["hierarchy"],
          },
        },
        explanation: {
          ruleId: "project.effective-assignee",
          description:
            "An explicit default assignee or None wins; otherwise follow the parent project default.",
          projections: {
            list: "assigneeId",
            detail: "assigneeId",
            summary: "assigneeId",
          },
          sourceDependencies: [
            {
              path: "fields.assigneeId.result.decision.provenance.source",
              label: "Source",
            },
            {
              path: "fields.assigneeId.current.assignment.value",
              label: "Stored override",
            },
            {
              path: "fields.assigneeId.current.controls.reset.preview.result.decision.outcome.value",
              label: "Inherited value",
            },
          ],
        },
        validation: {
          read: ledgerPartyShortcode.nullable(),
          create: ledgerPartyShortcode.nullable().optional(),
          update: ledgerPartyShortcode.nullable().optional(),
        },
      },
      {
        output: false,
        key: "assigneeMode",
        kind: "enum",
        validation: {
          read: null,
          create: inheritanceModeSchema.optional(),
          update: inheritanceModeSchema.optional(),
        },
        display: {
          optionRole: "category",
          optionColor: "domain-house",
          optionGlyph: {
            phosphor: "ArrowBendDownRight",
            sfSymbol: "arrow.turn.down.right",
          },
          valueOptions: [
            { value: "inherit", label: "Inherit" },
            { value: "explicit", label: "Explicit" },
          ],
        },
      },
      {
        display: { detail: false, list: false },
        key: "assigneeName",
        kind: "text",
        validation: {
          read: z.string().nullable(),
          create: null,
          update: null,
        },
      },
      {
        key: "defaultTrade",
        kind: "enum",
        nullable: true,
        control: {
          kind: "select",
          options: selectControlOptions.trade,
          // Project has no vendor field, unlike `expense.trade`/
          // `purchase.defaultTrade` — `name`/`notes`/`kind` are the only
          // signal available.
          suggest: {
            basis: ["name", "notes", "kind"],
            rules: [TRADE_SUGGEST_RULE],
          },
        },
        display: { list: false },
        resolution: {
          reset: { defaultTrade: null },
          redundancy: "eligible",
          inherit: { from: ["hierarchy"] },
        },
        explanation: {
          ruleId: "project.effective-default-trade",
          description:
            "A project trade override wins; otherwise the nearest parent project with a default trade supplies it.",
          projections: {
            list: "defaultTrade",
            detail: "defaultTrade",
            summary: "defaultTrade",
          },
          sourceDependencies: [
            {
              path: "fields.defaultTrade.result.decision.provenance.source",
              label: "Source",
            },
            {
              path: "fields.defaultTrade.current.assignment.value",
              label: "Stored override",
            },
            {
              path: "fields.defaultTrade.current.controls.reset.preview.result.decision.outcome.value",
              label: "Inherited value",
            },
          ],
        },
        validation: {
          read: tradeSchema.nullable(),
          create: tradeSchema.nullable().default(null),
          update: tradeSchema.nullable().optional(),
        },
      },
      {
        key: "costEstimate",
        kind: "number",
        nullable: true,
        control: {
          kind: "number",
          renderer: "money",
          placeholder: "e.g. 500",
        },
        display: {
          columnGroup: "Plan",
          columnBar: true,
          mobile: { slot: "trailing", priority: 10 },
          columnLabel: "Estimate",
          preview: true,
        },
        validation: {
          read: positiveMoneyNullable
            .describe("Budget estimate in dollars")
            .nullable(),
          create: positiveMoneyNullable.default(null),
          update: positiveMoneyNullable.optional(),
        },
      },
      {
        key: "parentProjectId",
        kind: "identifier",
        nullable: true,
        reference: { entity: "project" },
        control: { kind: "specialized", renderer: "entity-select" },
        display: { columnGroup: "Dependencies", columnLabel: "Parent" },
        validation: {
          read: projectShortcode.nullable(),
          create: projectShortcode.nullable().default(null),
          update: projectShortcode.nullable().optional(),
        },
      },
      {
        key: "dates",
        kind: "dateRange",
        nullable: true,
        dateRange: {
          start: "startDate",
          end: "endDate",
          semantics: "period",
        },
        control: { kind: "dateRange" },
        display: { columnGroup: "Plan", columnIdOverride: "startDate" },
        validation: {
          read: storedDateRangeSchema.nullable(),
          create: dateRangeSchema.nullable().default(null),
          update: dateRangeSchema.nullable().optional(),
        },
      },
      { output: false, key: "startDate", kind: "date", nullable: true },
      { output: false, key: "endDate", kind: "date", nullable: true },

      {
        key: "notes",
        kind: "text",
        nullable: true,
        control: { kind: "textarea" },
        display: { columnGroup: "Plan", width: "xl" },
        validation: {
          read: z.string().describe("Freeform markdown").nullable(),
          create: z.string().nullable().default(null),
          update: z.string().nullable().optional(),
        },
      },
      {
        key: "googleDriveFolderUrl",
        kind: "text",
        nullable: true,
        // Stored as a `(google-drive, folder)` EntityExternalId.
        provenance: {
          kind: "relation",
          sources: [{ label: "Google Drive folder identifier" }],
        },
        control: { kind: "text", renderer: "url" },
        display: { columnGroup: "References", columnLabel: "Drive folder" },
        validation: {
          read: googleDriveFolderUrl,
          create: googleDriveFolderUrl.default(null),
          update: googleDriveFolderUrl.optional(),
        },
      },
      {
        key: "notionPageUrl",
        kind: "text",
        nullable: true,
        // Stored as the url of the project's `(notion, page)` EntityExternalId.
        provenance: {
          kind: "relation",
          sources: [{ label: "Notion page identifier" }],
        },
        control: { kind: "text", renderer: "url" },
        display: { columnGroup: "References", columnLabel: "Notion page" },
        validation: {
          read: notionPageUrl,
          create: notionPageUrl.default(null),
          update: notionPageUrl.optional(),
        },
      },
      {
        audit: false,
        key: "blockedByIds",
        kind: "identifier",
        reference: { entity: "project", multiple: true },
        control: { kind: "specialized", renderer: "entity-multi-select" },
        display: { columnGroup: "Dependencies", columnLabel: "Blocked by" },
        validation: {
          read: z.array(projectShortcode),
          create: null,
          update: z
            .array(projectShortcode)
            .describe("Full replacement set of blocking-project ids")
            .optional(),
        },
      },
      {
        display: { detail: false, list: false },
        key: "id",
        kind: "identifier",
        validation: {
          read: projectShortcode,
          create: null,
          update: null,
        },
      },
      {
        key: "parentProjectName",
        kind: "text",
        nullable: true,
        display: { columnGroup: "Dependencies", detail: false },
        provenance: {
          kind: "derived",
          sources: [{ entity: "project", relation: "parent" }],
        },
        explanation: {
          ruleId: "project.parentProjectName",
          description:
            "The parent project name is read from the current live parent project selected by this project's parent link.",
          readPath: "parentProjectName",
          sourceDependencies: [
            { path: "parentProjectId", label: "Parent project" },
          ],
        },
        validation: {
          read: z.string().nullable(),
          create: null,
          update: null,
        },
      },
      {
        key: "childProjectIds",
        kind: "identifier",
        reference: { entity: "project", multiple: true },
        display: {
          columnGroup: "Dependencies",
          detail: false,
          columnLabel: "Subprojects",
        },
        validation: {
          read: z.array(projectShortcode),
          create: null,
          update: null,
        },
      },
      {
        key: "blockingIds",
        kind: "identifier",
        reference: { entity: "project", multiple: true },
        display: { columnGroup: "Dependencies" },
        validation: {
          read: z.array(projectShortcode),
          create: null,
          update: null,
        },
      },
      timestampField("createdAt", { detail: false, list: false }),
      timestampField("updatedAt"),
      {
        display: { detail: false, list: false },
        key: "rollup",
        provenance: {
          kind: "derived",
          sources: [{ label: "Project activity and descendants" }],
        },
        storedKey: "rollups",
        storedPath: ["rollup"],
        kind: "json",
        validation: {
          read: projectRollup.nullable(),
          create: null,
          update: null,
        },
      },
      // Preview projections of `rollup`: the numbers a hover asks for.
      {
        key: "spent",
        provenance: {
          kind: "derived",
          sources: [{ label: "Project expense allocations" }],
        },
        kind: "number",
        display: {
          detail: false,
          list: false,
          preview: true,
          format: "currency",
        },
        validation: {
          read: z
            .number()
            .describe("`rollup.spent`: the project's own net spend")
            .nullable(),
          create: null,
          update: null,
        },
      },
      {
        key: "taskProgress",
        labelOverride: "Tasks",
        kind: "text",
        provenance: {
          kind: "derived",
          sources: [{ label: "Own task completion rollup" }],
        },
        display: {
          columnGroup: "Work",
          detail: false,
          preview: true,
          labelPath: "taskProgress",
          renderer: { list: "task-progress" },
        },
        validation: {
          read: z
            .string()
            .describe("Done over total own tasks, e.g. `3/5`")
            .nullable(),
          create: null,
          update: null,
        },
      },
      {
        display: { detail: false, list: false },
        key: "dateWindow",
        provenance: {
          kind: "derived",
          sources: [{ label: "Project dates and activity" }],
        },
        storedKey: "rollups",
        storedPath: ["dateWindow"],
        kind: "json",
        validation: {
          read: projectDateWindow.nullable(),
          create: null,
          update: null,
        },
      },
      { output: false, key: "shortcode", kind: "text" },
      { output: false, key: "deletedAt", kind: "timestamp", nullable: true },
    ],
    storage: [
      "emoji",
      {
        key: "id",
        specialized: "primary-key:ProjectId",
      },
      { key: "shortcode", specialized: "shortcode" },
      "name",
      {
        key: "status",
        defaultValue: "'planning'",
        specialized: "enum:status",
      },
      { key: "kind", specialized: "enum:kind" },
      {
        key: "locations",
        defaultValue: "'{}'::text[]",
        specialized: "text-array",
      },
      {
        key: "locationsMode",
        defaultValue: "'inherit'",
        specialized: "enum:inheritance-mode",
      },
      "assigneeId",
      {
        key: "assigneeMode",
        defaultValue: "'inherit'",
        specialized: "enum:inheritance-mode",
      },
      { key: "defaultTrade", specialized: "enum:defaultTrade" },
      { key: "costEstimate", specialized: "double-precision" },
      "parentProjectId",
      "startDate",
      "endDate",
      "notes",
      { key: "createdAt" },
      { key: "updatedAt", specialized: "updated-at" },
      "deletedAt",
    ],

    rows: {
      attentionItems: {
        label: "Attention items",
        repository: { type: "text" },
      },
    },
    stored: {
      rollups: {
        compute: "project.rollups",
        publishes: "derivedValue",
        resultSchema: projectRollupResult,
        inputs: PROJECT_ROLLUP_INPUTS,
        dependsOn: [
          {
            entity: "project",
            key: "rollups",
            match: { parentProjectId: "id" },
          },
        ],
      },
    },
    derived: {
      spent: {
        type: "number",
        fromResult: { key: "rollups", path: ["rollup", "spent"] },
      },
      taskProgress: {
        type: "text",
        fromResult: { key: "rollups", path: ["taskProgress"] },
      },
      // Orders by the effective assignee's name.
      assigneeId: { via: "assignee" },
      // The effective start: the stored date, else the earliest task or
      // expense date in the subtree below an unset start. Stored (ADR 0021):
      // the recursive fold per row made start-date sorts ~430-630 ms.
      startDate: {
        type: "date",
        stored: {
          compute: "project.startDate",
          inputs: PROJECT_DATE_INPUTS,
          dependsOn: [
            {
              entity: "project",
              key: "startDate",
              match: { parentProjectId: "id" },
            },
          ],
        },
      },
      // A displayable image (PDF attachments don't count).
      image: { type: "boolean" },
      // Tracker membership, from the attention rules over tasks and budgets.
      attention: { via: "attentionItems.type", requiresResult: "rollups" },
      dateRange: {
        predicate: "range",
        reason:
          "A project matches by its own dates or by any dated task or expense under it",
      },
      // The year of the subtree's effective end, folded in TS and stored.
      completionYear: {
        type: "text",
        stored: {
          compute: "project.completionYear",
          inputs: PROJECT_DATE_INPUTS,
          dependsOn: [
            {
              entity: "project",
              key: "completionYear",
              match: { parentProjectId: "id" },
            },
          ],
        },
      },
    },
    sort: {
      fields: [
        "assigneeId",
        "name",
        "status",
        "kind",
        "startDate",
        "costEstimate",
        "completionYear",
        "createdAt",
        "updatedAt",
      ],
    },
    grouping: ["completionYear"],
    intents: {
      fields: {
        capture: [
          "emoji",
          "name",
          "status",
          "kind",
          "costEstimate",
          "parentProjectId",
          "locations",
          "locationsMode",
          "assigneeId",
          "assigneeMode",
          "defaultTrade",
          "dates",
        ],
        full: [
          "emoji",
          "name",
          "status",
          "kind",
          "parentProjectId",
          "dates",

          "costEstimate",
          "locations",
          "locationsMode",
          "assigneeId",
          "assigneeMode",
          "defaultTrade",
          "googleDriveFolderUrl",
          "notionPageUrl",
          "blockedByIds",
          "notes",
        ],
        status: ["emoji", "status"],
        kind: ["emoji", "kind"],
        dates: ["emoji", "dates"],
        parent: ["emoji", "parentProjectId"],
      },
      create: ["capture", "full"],
      update: ["full", "status", "kind", "dates", "parent"],
    },
  },
  fields: {
    list: {
      module: "@cubby/schemas/work-raw-read",
      export: "rawProjectListItemOut",
    },
    detail: {
      module: "@cubby/schemas/work-raw-read",
      export: "rawProjectOut",
    },

    mcpList: {
      module: "@cubby/schemas/work-raw-read",
      export: "rawProjectListItemOut",
    },
    mcpDetail: {
      module: "@cubby/schemas/work-raw-read",
      export: "rawProjectOut",
    },
  },
  storage: {
    indexes: [
      { on: ["status"] },
      { on: ["kind"] },
      { on: ["startDate"] },
      { trigram: "name" },
      {
        name: "Project_name_active_idx",
        on: ["name"],
        where: "{deletedAt} IS NULL",
      },
    ],
    relations: {
      assignee: "assigneeId",
      tasks: { many: "task" },
      expenses: { many: "expense" },
      images: { many: "entityAttachment" },
      parentProject: {
        field: "parentProjectId",
        relationName: "ProjectToProject",
      },
      childProjects: { many: "project", relationName: "ProjectToProject" },
    },
  },
  filters: {
    audit: true,
    schema: {
      module: "@cubby/schemas/project",
      export: "projectFilterFields",
    },
    descriptors: [
      {
        columnId: "assigneeId",
        urlKey: "assignee",
        field: "assigneeId",
        kind: "idMulti",
        placeholder: "Filter by assignee...",
        optionsKey: "ledgerParty",
        brandRef: { entity: "ledgerParty" },
        currentMember: true,
      },

      {
        columnId: "image",
        deriveSchema: true,
        schemaDescription:
          "Filter to projects that do / don't have at least one image (PDF attachments don't count).",
        field: "imagePresenceFilter",
        kind: "presence",
        placeholder: "Filter images...",
        options: [
          { value: "has", label: "Has image", meta: true },
          { value: "none", label: "(none)", meta: true },
        ],
      },
      {
        columnId: "name",
        field: "search",
        kind: "text",
        placeholder: "Filter by project name...",
        deriveSchema: true,
        anyOf: ["name", "notes", "locations"],
      },
      {
        columnId: "status",
        urlKey: "statuses",
        kind: "multiselect",
        placeholder: "Filter by status...",
        deriveSchema: true,
        schemaRef: {
          module: "@cubby/schemas/project-fields",
          export: "projectStatusSchema",
        },
        options: [
          { value: "planning", label: "Planning", color: "var(--chart-5)" },
          {
            value: "not_started",
            label: "Not started",
            color: "var(--chart-neutral)",
          },
          {
            value: "in_progress",
            label: "In progress",
            color: "var(--chart-1)",
          },
          { value: "done", label: "Done", color: "var(--chart-positive)" },
        ],
      },
      {
        columnId: "kind",
        urlKey: "kinds",
        kind: "multiselect",
        placeholder: "Filter by kind...",
        deriveSchema: true,
        schemaRef: {
          module: "@cubby/schemas/project-fields",
          export: "projectKindSchema",
        },
        options: [
          { value: "furniture", label: "Furniture" },
          { value: "workshop", label: "Workshop" },
          { value: "household", label: "Household" },
          { value: "renovation", label: "Renovation" },
          { value: "garden", label: "Garden" },
          { value: "trip", label: "Trip" },
        ],
      },
      {
        columnId: "attention",
        deriveSchema: true,
        kind: "multiselect",
        placeholder: "Filter tracker attention...",
        options: [
          { value: "stalled", label: "Stalled" },
          { value: "missing_budget", label: "Missing budget" },
          { value: "spend_below_estimate", label: "Spend below estimate" },
          {
            value: "blocked_no_next_action",
            label: "Blocked with no next action",
          },
        ],
      },
      {
        columnId: "locations",
        field: "location",
        urlKey: "locations",
        kind: "multiselect",
        placeholder: "Filter by location...",
        deriveSchema: true,
        schemaDescription:
          "Any exact match against the effective (possibly inherited) locations",
        stored: { array: true },
        optionsKey: "projectLocations",
      },
      {
        columnId: "dateRange",
        derived: true,
        urlKey: "date",
        kind: "range",
        wire: { kind: "range", from: "dateFrom", to: "dateTo" },
        placeholder: "Filter by project activity...",
        options: [...historicalDateRangePresets],
        expandRef: {
          module: "~/lib/date-range-presets",
          export: "resolveDateRange",
        },
      },
      {
        columnId: "completionYear",
        urlKey: "completed",
        kind: "multiselect",
        placeholder: "Filter by completion year...",
        optionsKey: "projectCompletionYears",
      },
      {
        columnId: "parent",
        field: "parentProjectId",
        kind: "idMulti",
        placeholder: "Filter by parent project...",
        optionsKey: "project",
        brandRef: { entity: "project" },
        label: "Parent project",
        deriveSchema: true,
        stored: { columns: ["parentProjectId"] },
      },
      {
        columnId: "related:project.blockedBy",
        field: "projectSearch",
        urlKey: "related-project",
        kind: "text",
        placeholder: "Search related blocked by...",
      },
      {
        columnId: "projectId",
        kind: "idMulti",
        placeholder: "Filter by related blocked by id...",
        brandRef: { entity: "project" },
      },
      {
        columnId: "projectPresenceFilter",
        kind: "presence",
        placeholder: "Filter related blocked by presence...",
      },
      {
        columnId: "related:project.tasks",
        field: "taskSearch",
        urlKey: "related-task",
        kind: "text",
        placeholder: "Search related tasks...",
      },
      {
        columnId: "taskId",
        kind: "idMulti",
        placeholder: "Filter by related tasks id...",
        brandRef: { entity: "task" },
      },
      {
        columnId: "taskPresenceFilter",
        kind: "presence",
        placeholder: "Filter related tasks presence...",
      },
      {
        columnId: "related:project.expenses",
        field: "expenseSearch",
        urlKey: "related-expense",
        kind: "text",
        placeholder: "Search related expenses...",
      },
      {
        columnId: "expenseId",
        kind: "idMulti",
        placeholder: "Filter by related expenses id...",
        brandRef: { entity: "expense" },
      },
      {
        columnId: "expensePresenceFilter",
        kind: "presence",
        placeholder: "Filter related expenses presence...",
      },
      {
        columnId: "related:project.taskProducts",
        field: "taskProductSearch",
        urlKey: "related-taskProduct",
        kind: "text",
        placeholder: "Search related task products...",
      },
      {
        columnId: "taskProductId",
        kind: "idMulti",
        placeholder: "Filter by related task products id...",
        brandRef: { entity: "product" },
      },
      {
        columnId: "taskProductPresenceFilter",
        kind: "presence",
        placeholder: "Filter related task products presence...",
      },
      {
        columnId: "related:project.purchasedProducts",
        field: "purchasedProductSearch",
        urlKey: "related-purchasedProduct",
        kind: "text",
        placeholder: "Search related purchased products...",
      },
      {
        columnId: "purchasedProductId",
        kind: "idMulti",
        placeholder: "Filter by related purchased products id...",
        brandRef: { entity: "product" },
      },
      {
        columnId: "purchasedProductPresenceFilter",
        kind: "presence",
        placeholder: "Filter related purchased products presence...",
      },
      {
        columnId: "related:project.usedTools",
        field: "usedToolSearch",
        urlKey: "related-usedTool",
        kind: "text",
        placeholder: "Search related reusable resources...",
      },
      {
        columnId: "usedToolId",
        kind: "idMulti",
        placeholder: "Filter by related reusable resources id...",
        brandRef: { entity: "product" },
      },
      {
        columnId: "usedToolPresenceFilter",
        kind: "presence",
        placeholder: "Filter related reusable resources presence...",
      },
      {
        columnId: "related:project.vendors",
        field: "vendorSearch",
        urlKey: "related-vendor",
        kind: "text",
        placeholder: "Search related vendors...",
      },
      {
        columnId: "vendorId",
        kind: "idMulti",
        placeholder: "Filter by related vendors id...",
        brandRef: { entity: "vendor" },
      },
      {
        columnId: "vendorPresenceFilter",
        kind: "presence",
        placeholder: "Filter related vendors presence...",
      },
    ],
  },

  search: {
    mode: "semantic",
    inputs: [...imageDescriptionInputs("project")],
  },
  capabilities: {
    images: {
      storage: imageAssociationStorage.shape.project.value,
      displaySources: [
        {
          relationPath: ["tasks"],
          ordering: "newest",
        },
        {
          relationPath: ["task-products"],
        },
        {
          relationPath: ["purchased-products"],
        },
        {
          relationPath: ["resources"],
        },
      ],
      ingress: [
        { kind: "self", routeId: "project-self", choice: "primary" },
        {
          kind: "createSelf",
          routeId: "project-new",
          enabled: false,
          disabledReason:
            "Projects need a plan before photos; create one in Projects first",
        },
      ],
      routing: {
        category: "home",
        candidateFields: ["name", "notes"],
        temporalFields: ["dates.start", "dates.end"],
        lifecycleFilters: [
          {
            field: "status",
            oneOf: ["planning", "not_started", "in_progress"],
          },
        ],
        signals: {
          ocrFields: ["name", "notes"],
          classifierLabels: ["toolbox"],
        },
        abstention: { minimumScore: 0.72, minimumMargin: 0.12 },
      },
    },
    delete: { mode: "soft", bulk: true },
    merge: false,
    dataQuality: {
      inputs: [
        {
          table: "Purchase",
          match: { defaultProjectId: "id" },
          columns: ["defaultProjectId", "deletedAt"],
        },
        {
          table: "Purchase",
          match: { id: "id" },
          columns: ["vendorId", "defaultProjectId", "deletedAt"],
          path: [{ table: "Expense", from: "purchaseId", to: "projectId" }],
        },
        {
          table: "ProductCategory",
          match: { id: "id" },
          columns: ["feature", "parentId", "deletedAt"],
          path: [
            { table: "Product", from: "categoryId", to: "id" },
            { table: "Expense", from: "productId", to: "projectId" },
          ],
        },

        {
          table: "Task",
          match: { projectId: "id" },
          columns: ["deletedAt", "id"],
          path: [{ table: "Project", from: "id", to: "id" }],
        },
        {
          table: "EntityAttachment",
          match: { entityId: "id" },
          columns: ["deletedAt", "imageId", "purpose", "role"],
          path: [
            { table: "Task", from: "id", to: "projectId" },
            { table: "Project", from: "id", to: "id" },
          ],
        },
        {
          table: "Image",
          match: { id: "id" },
          columns: [
            "deletedAt",
            "renderStatus",
            "storageStatus",
            "detectedContentType",
          ],
          path: [
            { table: "EntityAttachment", from: "imageId", to: "entityId" },
            { table: "Task", from: "id", to: "projectId" },
            { table: "Project", from: "id", to: "id" },
          ],
        },
        {
          table: "Task",
          match: { projectId: "id" },
          columns: ["deletedAt", "subjectProductId"],
          path: [{ table: "Project", from: "id", to: "id" }],
        },
        {
          table: "Product",
          match: { id: "id" },
          columns: ["deletedAt", "id"],
          path: [
            { table: "Task", from: "subjectProductId", to: "projectId" },
            { table: "Project", from: "id", to: "id" },
          ],
        },
        {
          table: "EntityAttachment",
          match: { entityId: "id" },
          columns: ["deletedAt", "imageId", "purpose", "role"],
          path: [
            { table: "Product", from: "id", to: "id" },
            { table: "Task", from: "subjectProductId", to: "projectId" },
            { table: "Project", from: "id", to: "id" },
          ],
        },
        {
          table: "Image",
          match: { id: "id" },
          columns: [
            "deletedAt",
            "renderStatus",
            "storageStatus",
            "detectedContentType",
          ],
          path: [
            { table: "EntityAttachment", from: "imageId", to: "entityId" },
            { table: "Product", from: "id", to: "id" },
            { table: "Task", from: "subjectProductId", to: "projectId" },
            { table: "Project", from: "id", to: "id" },
          ],
        },
        {
          table: "Expense",
          match: { projectId: "id" },
          columns: [
            "deletedAt",
            "productId",
            "purchaseId",
            "projectId",
            "lineKind",
          ],
          path: [{ table: "Project", from: "id", to: "id" }],
        },
        {
          table: "Product",
          match: { id: "id" },
          columns: ["deletedAt", "id"],
          path: [
            { table: "Expense", from: "productId", to: "projectId" },
            { table: "Project", from: "id", to: "id" },
          ],
        },
        {
          table: "EntityAttachment",
          match: { entityId: "id" },
          columns: ["deletedAt", "imageId", "purpose", "role"],
          path: [
            { table: "Product", from: "id", to: "id" },
            { table: "Expense", from: "productId", to: "projectId" },
            { table: "Project", from: "id", to: "id" },
          ],
        },
        {
          table: "Image",
          match: { id: "id" },
          columns: [
            "deletedAt",
            "renderStatus",
            "storageStatus",
            "detectedContentType",
          ],
          path: [
            { table: "EntityAttachment", from: "imageId", to: "entityId" },
            { table: "Product", from: "id", to: "id" },
            { table: "Expense", from: "productId", to: "projectId" },
            { table: "Project", from: "id", to: "id" },
          ],
        },
        {
          table: "EntityLink",
          match: { fromEntityId: "id" },
          columns: ["deletedAt", "toEntityId"],
          path: [{ table: "Project", from: "id", to: "id" }],
          where: { kind: "projectTool" },
        },
        {
          table: "Product",
          match: { id: "id" },
          columns: ["deletedAt", "id"],
          path: [
            {
              table: "EntityLink",
              from: "toEntityId",
              to: "fromEntityId",
              where: { kind: "projectTool" },
            },
            { table: "Project", from: "id", to: "id" },
          ],
        },
        {
          table: "EntityAttachment",
          match: { entityId: "id" },
          columns: ["deletedAt", "imageId", "purpose", "role"],
          path: [
            { table: "Product", from: "id", to: "id" },
            {
              table: "EntityLink",
              from: "toEntityId",
              to: "fromEntityId",
              where: { kind: "projectTool" },
            },
            { table: "Project", from: "id", to: "id" },
          ],
        },
        {
          table: "Image",
          match: { id: "id" },
          columns: [
            "deletedAt",
            "renderStatus",
            "storageStatus",
            "detectedContentType",
          ],
          path: [
            { table: "EntityAttachment", from: "imageId", to: "entityId" },
            { table: "Product", from: "id", to: "id" },
            {
              table: "EntityLink",
              from: "toEntityId",
              to: "fromEntityId",
              where: { kind: "projectTool" },
            },
            { table: "Project", from: "id", to: "id" },
          ],
        },
        {
          table: "Product",
          match: { id: "id" },
          columns: ["deletedAt", "brandId"],
          path: [
            { table: "Task", from: "subjectProductId", to: "projectId" },
            { table: "Project", from: "id", to: "id" },
          ],
        },
        {
          table: "Vendor",
          match: { id: "id" },
          columns: ["deletedAt", "id"],
          path: [
            { table: "Product", from: "brandId", to: "id" },
            { table: "Task", from: "subjectProductId", to: "projectId" },
            { table: "Project", from: "id", to: "id" },
          ],
        },
        {
          table: "EntityAttachment",
          match: { entityId: "id" },
          columns: ["deletedAt", "imageId", "purpose", "role"],
          path: [
            { table: "Vendor", from: "id", to: "id" },
            { table: "Product", from: "brandId", to: "id" },
            { table: "Task", from: "subjectProductId", to: "projectId" },
            { table: "Project", from: "id", to: "id" },
          ],
        },
        {
          table: "Image",
          match: { id: "id" },
          columns: [
            "deletedAt",
            "renderStatus",
            "storageStatus",
            "detectedContentType",
          ],
          path: [
            { table: "EntityAttachment", from: "imageId", to: "entityId" },
            { table: "Vendor", from: "id", to: "id" },
            { table: "Product", from: "brandId", to: "id" },
            { table: "Task", from: "subjectProductId", to: "projectId" },
            { table: "Project", from: "id", to: "id" },
          ],
        },
        {
          table: "Product",
          match: { id: "id" },
          columns: ["deletedAt", "brandId"],
          path: [
            { table: "Expense", from: "productId", to: "projectId" },
            { table: "Project", from: "id", to: "id" },
          ],
        },
        {
          table: "Vendor",
          match: { id: "id" },
          columns: ["deletedAt", "id"],
          path: [
            { table: "Product", from: "brandId", to: "id" },
            { table: "Expense", from: "productId", to: "projectId" },
            { table: "Project", from: "id", to: "id" },
          ],
        },
        {
          table: "EntityAttachment",
          match: { entityId: "id" },
          columns: ["deletedAt", "imageId", "purpose", "role"],
          path: [
            { table: "Vendor", from: "id", to: "id" },
            { table: "Product", from: "brandId", to: "id" },
            { table: "Expense", from: "productId", to: "projectId" },
            { table: "Project", from: "id", to: "id" },
          ],
        },
        {
          table: "Image",
          match: { id: "id" },
          columns: [
            "deletedAt",
            "renderStatus",
            "storageStatus",
            "detectedContentType",
          ],
          path: [
            { table: "EntityAttachment", from: "imageId", to: "entityId" },
            { table: "Vendor", from: "id", to: "id" },
            { table: "Product", from: "brandId", to: "id" },
            { table: "Expense", from: "productId", to: "projectId" },
            { table: "Project", from: "id", to: "id" },
          ],
        },
        {
          table: "Product",
          match: { id: "id" },
          columns: ["deletedAt", "brandId"],
          path: [
            {
              table: "EntityLink",
              from: "toEntityId",
              to: "fromEntityId",
              where: { kind: "projectTool" },
            },
            { table: "Project", from: "id", to: "id" },
          ],
        },
        {
          table: "Vendor",
          match: { id: "id" },
          columns: ["deletedAt", "id"],
          path: [
            { table: "Product", from: "brandId", to: "id" },
            {
              table: "EntityLink",
              from: "toEntityId",
              to: "fromEntityId",
              where: { kind: "projectTool" },
            },
            { table: "Project", from: "id", to: "id" },
          ],
        },
        {
          table: "EntityAttachment",
          match: { entityId: "id" },
          columns: ["deletedAt", "imageId", "purpose", "role"],
          path: [
            { table: "Vendor", from: "id", to: "id" },
            { table: "Product", from: "brandId", to: "id" },
            {
              table: "EntityLink",
              from: "toEntityId",
              to: "fromEntityId",
              where: { kind: "projectTool" },
            },
            { table: "Project", from: "id", to: "id" },
          ],
        },
        {
          table: "Image",
          match: { id: "id" },
          columns: [
            "deletedAt",
            "renderStatus",
            "storageStatus",
            "detectedContentType",
          ],
          path: [
            { table: "EntityAttachment", from: "imageId", to: "entityId" },
            { table: "Vendor", from: "id", to: "id" },
            { table: "Product", from: "brandId", to: "id" },
            {
              table: "EntityLink",
              from: "toEntityId",
              to: "fromEntityId",
              where: { kind: "projectTool" },
            },
            { table: "Project", from: "id", to: "id" },
          ],
        },
      ],

      checks: [
        {
          id: "project_kind",
          satisfiedLabel: "Kind recorded",
          placement: { field: "kind" },
          facet: "identity",
          weight: 1,
          label: "Kind",
          message: "No project kind is recorded.",
        },
        {
          id: "project_start_date",
          satisfiedLabel: "Start date recorded",
          placement: { field: "dates" },
          facet: "paperwork",
          weight: 1,
          label: "Start date",
          message: "No start date is recorded for a project that has begun.",
        },
        {
          id: "project_date_order",
          satisfiedLabel: "Dates in order",
          placement: { field: "dates" },
          facet: "integrity",
          kind: "defect",
          weight: 2,
          scoreCap: 49,
          label: "Date order",
          message: "The end date is before the start date.",
        },
      ],
    },
  },
  extensions: {
    ports: {
      repository: {
        module: "~/server/domains/project/repo/repository",
        export: "projectRepository",
      },
      search: "document",
    },
  },
});

export default defineEntity(
  definition,
  (r) => [
    r.field("assigneeId").named("assignee", "Default assignee"),
    r
      .path("project", "many", [
        { edge: "Project.parentProjectId", direction: "incoming" },
      ])
      .named("sub-projects", "Sub-projects"),
    r
      .path("purchase", "many", [
        { edge: "Expense.projectId", direction: "incoming" },
        { edge: "Expense.purchaseId", direction: "outgoing" },
      ])
      .named("purchases", "Purchases"),
    r.field("parentProjectId").named("parent", "Parent project"),
    r.link("projectDependency", "outgoing").named("blocked-by", "Blocked by", {
      view: {
        key: "blockedBy",
        columnGroup: "Dependencies",
        defaultVisible: true,
      },
    }),
    r.link("projectTool", "outgoing").named("resources", "Reusable resources", {
      view: {
        key: "usedTools",
        columnGroup: "Work",
        filterPrefix: "usedTool",
        inverseKey: "product.usedOnProjects",
        defaultVisible: true,
      },
      sourceKey: "explicit",
      mutation: {
        source: "explicit",
        itemSchema: {
          module: "@cubby/schemas/common",
          export: "entityRelationReferenceItemSchema",
        },
        rowSchema: {
          module: "@cubby/schemas/project",
          export: "projectResourceOut",
        },
        adapter: {
          module: "~/server/domains/project/repo/tools",
          export: "projectResourcesRelationAdapter",
        },
        audiences: ["browser", "mcp"],
      },
    }),
    r
      .path("purchase", "many", [
        { edge: "Purchase.defaultProjectId", direction: "incoming" },
      ])
      .named("defaultPurchases", "Purchases using this default"),
    r
      .path("task", "many", [{ edge: "Task.projectId", direction: "incoming" }])
      .named("tasks", "Tasks", {
        view: { columnGroup: "Work", order: "task" },
      }),
    r
      .path("expense", "many", [
        { edge: "Expense.projectId", direction: "incoming" },
      ])
      .named("expenses", "Expenses", {
        view: { columnGroup: "Purchasing", order: "newest" },
      }),
    r
      .path("product", "many", [
        { edge: "Task.projectId", direction: "incoming" },
        { edge: "Task.subjectProductId", direction: "outgoing" },
      ])
      .named("task-products", "Task products", {
        view: {
          key: "taskProducts",
          columnGroup: "Work",
          filterPrefix: "taskProduct",
        },
      }),
    r
      .path("product", "many", [
        { edge: "Expense.projectId", direction: "incoming" },
        { edge: "Expense.productId", direction: "outgoing" },
      ])
      .named("purchased-products", "Purchased products", {
        view: {
          key: "purchasedProducts",
          columnGroup: "Purchasing",
          filterPrefix: "purchasedProduct",
          inverseKey: "product.projects",
        },
      }),
    r
      .path("vendor", "many", [
        { edge: "Expense.projectId", direction: "incoming" },
        { edge: "Expense.purchaseId", direction: "outgoing" },
        { edge: "Purchase.vendorId", direction: "outgoing" },
      ])
      .named("vendors", "Vendors", {
        view: {
          columnGroup: "Purchasing",
          inverseKey: "vendor.projects",
        },
      }),
    r
      .path("image", "many", [
        { edge: "EntityAttachment.entityId", direction: "incoming" },
        { edge: "EntityAttachment.imageId", direction: "outgoing" },
      ])
      .named("images", "Images"),
  ],
  readSchemas,
);
