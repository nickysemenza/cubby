import { imageDescriptionInputs } from "./image-description-inputs";
import { automaticFields } from "./automatic-fields";
import { dateRangeSchema, storedDateRangeSchema } from "../date-range";
import { imageAssociationStorage } from "./image-associations";
import { defineEntity } from "./definition.js";
import { MAX_PROJECT_TREE_DEPTH } from "../project-fields.js";
import { selectControlOptions } from "./select-control-options.js";
import {
  ledgerPartyShortcode,
  imageShortcode,
  productShortcode,
  projectShortcode,
  taskShortcode,
} from "../identifier-fields.js";
import {
  taskStatusSchema,
  taskStatusValues,
  tradeSchema,
  TRADE_SUGGEST_RULE,
} from "@cubby/schemas/task-fields";
import { optionalFieldResolutionsSchema } from "@cubby/schemas/field-resolution";
import { imageOut } from "./field-primitives.js";
import { CURRENT_MEMBER_FILTER } from "@cubby/shared";
import { FILTER_NONE } from "../filter-sentinel-fields.js";
import { z } from "zod";
const inheritanceModeSchema = z.enum(["inherit", "explicit"]);
/** A parent's subtasks; subtasks have none of their own. */
const SUBTASKS = { table: "Task", from: "parentTaskId", to: "id" } as const;

export default defineEntity({
  key: "task",
  names: { singular: "Task", plural: "Tasks" },
  route: {
    listColumns: {
      module: "~/features/task/list-columns",
      export: "taskListOverride",
    },
    basePath: "tasks",
  },
  table: "Task",
  identifiers: { brand: "TaskId", shortcode: "TSK-" },
  presentation: {
    edit: {
      sections: [
        {
          id: "schedule",
          title: "Schedule",
          fields: ["due"],
        },
        {
          id: "ordering",
          title: "Ordering",
          fields: ["sortOrder"],
        },
      ],
    },
    titleField: "name",
    domain: "house",
    description: "Concrete work, schedules, and completion state.",
    emptyState: {
      title: "No tasks yet",
      description:
        "Break a project down into steps, or jot down a one-off to get to later.",
      actionLabel: "New Task",
    },
    icons: { phosphor: "ListChecks", sfSymbol: "checklist", emoji: "✅" },
    detail: {
      summary: [
        {
          kind: "fields",
          id: "due-state",
          title: "Due & state",
          fields: ["due", "status"],
        },
        {
          kind: "records",
          id: "assignee",
          title: "Assignee",
          viewKey: "relation:assignee",
        },
        {
          kind: "records",
          id: "project",
          title: "Project",
          viewKey: "relation:project",
        },
        {
          kind: "records",
          id: "subject-product",
          title: "Subject Product",
          viewKey: "relation:subject",
        },
        {
          kind: "records",
          id: "blocked-by",
          title: "Blocked by",
          viewKey: "relation:blocked-by",
        },
        {
          kind: "records",
          id: "subtasks",
          title: "Subtasks",
          viewKey: "relation:subtasks",
        },
        {
          kind: "records",
          id: "parent-task",
          title: "Parent task",
          viewKey: "relation:parent",
        },
        {
          kind: "records",
          id: "supporting-evidence",
          title: "Supporting evidence",
          viewKey: "relation:images",
        },
      ],

      activityRelations: [
        { relation: "subtasks", dateField: "dueDate" },
        { relation: "blocked-by", dateField: "dueDate" },
        { relation: "images", dateField: "capturedAt" },
        { relation: "plantings", dateField: "sowedOn" },
      ],
      relationFilterOverrides: {
        subtasks: { descriptor: "parentTaskId" },
      },
      omitRelations: {
        "blocked-by":
          "The Dependencies section edits Blocked by and Blocking in place.",
      },
      hero: {
        chip: "status",
        extraActions: ["complete", "bulkEdit", "delete"],
      },
      quickActions: ["complete"],
      sections: [
        {
          kind: "fields",
          id: "overview",
          title: "Record",
          fields: [
            "name",
            "status",
            "assigneeId",
            "projectId",
            "subjectProductId",
            "parentTaskId",
            "trade",
          ],
        },
        { kind: "fields", id: "schedule", title: "Schedule", fields: ["due"] },
        {
          kind: "fields",
          id: "dependencies",
          title: "Dependencies",
          fields: ["blockedByIds", "blockingIds"],
        },
      ],
    },
    list: {
      // A project page's embedded task list: tasks whose effective project
      // its project filters select.
      scopes: { projectScope: { via: "project", filters: "project" } },
      savedViews: [
        {
          id: "my-tasks",
          label: "My tasks",
          description: "Open tasks assigned to your linked member",
          filters: [
            {
              id: "status",
              value: taskStatusValues.filter((status) => status !== "done"),
            },
            { id: "assigneeId", value: [CURRENT_MEMBER_FILTER] },
          ],
          pin: { surface: "home", order: 2 },
        },
        {
          id: "unassigned",
          label: "Unassigned",
          description: "Open tasks with no effective assignee",
          filters: [
            {
              id: "status",
              value: taskStatusValues.filter((status) => status !== "done"),
            },
            { id: "assigneeId", value: [FILTER_NONE] },
          ],
        },
        {
          id: "inbox",
          label: "Inbox",
          description: "Open top-level tasks with no project",
          filters: [
            {
              id: "status",
              value: taskStatusValues.filter((status) => status !== "done"),
            },
            { id: "projectId", value: [FILTER_NONE] },
            { id: "parentTaskId", value: [FILTER_NONE] },
          ],
        },
        {
          id: "completed",
          label: "Completed",
          description: "Finished tasks, including subtasks",
          filters: [{ id: "status", value: ["done"] }],
          sort: [{ id: "updatedAt", desc: true }],
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
        { kind: "slot", id: "agenda", label: "Next" },
        {
          kind: "board",
          id: "board",
          label: "Board",
          groupBy: "status",
          groupings: ["status", "projectId", "trade"],
          cardFields: ["projectId", "trade", "due", "status", "dataQuality"],
          filters: { topLevelOnly: true },
          pageSize: 50,
          caps: [
            {
              field: "status",
              value: "done",
              limit: 20,
              orderBy: "updatedAt",
              direction: "desc",
            },
          ],
          sort: [
            { orderBy: "sortOrder", direction: "asc" },
            { orderBy: "createdAt", direction: "desc" },
          ],
          reorder: { operation: "task.bulkReorder" },
        },
        "timeline",
      ],
      extraActions: ["complete"],
      quickActions: ["complete"],
      timeline: {
        fields: ["due.start", "due.end"],
        lifecycle: {
          start: "createdAt",
          milestones: ["due.start"],
          end: "due.end",
        },
      },
    },
  },
  model: {
    stored: { automaticFields: automaticFields("task", "Task") },
    hierarchy: {
      parentField: "parentTaskId",
      maxDepth: MAX_PROJECT_TREE_DEPTH,
    },
    fields: [
      {
        display: { detail: false, list: false },
        key: "fieldResolutions",
        kind: "json",
        validation: {
          read: optionalFieldResolutionsSchema,
          create: null,
          update: null,
        },
      },
      {
        key: "name",
        kind: "text",
        control: { kind: "text", placeholder: "What needs doing?" },
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
        control: { kind: "select", options: selectControlOptions.taskStatus },
        display: {
          columnGroup: "Work",
          mobile: { slot: "subtitle", priority: 10 },
        },
        validation: {
          read: taskStatusSchema,
          create: taskStatusSchema.default("not_started"),
          update: taskStatusSchema.optional(),
        },
      },
      {
        key: "assigneeId",
        kind: "identifier",
        nullable: true,
        reference: {
          entity: "ledgerParty",
          filters: [{ field: "kind", values: ["member"] }],
        },
        control: { kind: "specialized", renderer: "entity-select" },
        display: {
          columnGroup: "Assignment",
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
            from: ["hierarchy", { path: "project.assigneeId" }],
          },
        },
        explanation: {
          ruleId: "task.effective-assignee",
          description:
            "An explicit assignee or None wins; otherwise follow the parent task, then the effective project default.",
          projections: {
            list: "fieldResolutions.assigneeId.value",
            detail: "fieldResolutions.assigneeId.value",
            summary: "fieldResolutions.assigneeId.value",
          },
          sourceDependencies: [
            {
              path: "fieldResolutions.assigneeId.sourceEntity",
              label: "Source",
            },
            {
              path: "fieldResolutions.assigneeId.storedValue",
              label: "Stored override",
            },
            {
              path: "fieldResolutions.assigneeId.fallbackValue",
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
        validation: { read: z.string().nullable(), create: null, update: null },
      },
      {
        key: "projectId",
        kind: "identifier",
        nullable: true,
        reference: { entity: "project" },
        control: {
          kind: "specialized",
          renderer: "entity-select",
          suggest: { basis: ["name"] },
        },
        display: {
          columnGroup: "Assignment",
          width: "md",
          mobile: { slot: "meta", priority: 30, interactive: true },
        },
        resolution: {
          reset: { projectMode: "inherit", projectId: null },
          none: { projectMode: "explicit", projectId: null },
          redundancy: "eligible",
          inherit: {
            mode: {
              field: "projectMode",
              inherit: "inherit",
              explicitIfSet: true,
            },
            from: ["hierarchy"],
          },
        },
        explanation: {
          ruleId: "task.effective-project",
          description:
            "An explicit project choice wins; otherwise the task follows its parent.",
          projections: {
            list: "fieldResolutions.projectId.value",
            detail: "fieldResolutions.projectId.value",
            summary: "fieldResolutions.projectId.value",
          },
          sourceDependencies: [
            {
              path: "fieldResolutions.projectId.sourceEntity",
              label: "Source",
            },
            {
              path: "fieldResolutions.projectId.storedValue",
              label: "Stored override",
            },
            {
              path: "fieldResolutions.projectId.fallbackValue",
              label: "Inherited value",
            },
          ],
        },
        validation: {
          read: projectShortcode.nullable(),
          create: projectShortcode.nullable().default(null),
          update: projectShortcode.nullable().optional(),
        },
      },
      {
        key: "projectMode",
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
        key: "subjectProductId",
        kind: "identifier",
        nullable: true,
        reference: { entity: "product" },
        control: {
          kind: "specialized",
          renderer: "entity-select",
          suggest: { basis: ["name"] },
        },
        display: {
          columnGroup: "Assignment",
          columnLabel: "Product",
          width: "md",
          mobile: { slot: "meta", priority: 35, interactive: true },
        },
        resolution: {
          reset: { subjectProductMode: "inherit", subjectProductId: null },
          none: { subjectProductMode: "explicit", subjectProductId: null },
          redundancy: "eligible",
          inherit: {
            mode: {
              field: "subjectProductMode",
              inherit: "inherit",
              explicitIfSet: true,
            },
            from: ["hierarchy"],
          },
        },
        explanation: {
          ruleId: "task.effective-subject-product",
          description:
            "An explicit product choice wins; otherwise the task follows its parent.",
          projections: {
            list: "fieldResolutions.subjectProductId.value",
            detail: "fieldResolutions.subjectProductId.value",
            summary: "fieldResolutions.subjectProductId.value",
          },
          sourceDependencies: [
            {
              path: "fieldResolutions.subjectProductId.sourceEntity",
              label: "Source",
            },
            {
              path: "fieldResolutions.subjectProductId.storedValue",
              label: "Stored override",
            },
            {
              path: "fieldResolutions.subjectProductId.fallbackValue",
              label: "Inherited value",
            },
          ],
        },
        validation: {
          read: productShortcode.nullable(),
          create: productShortcode.nullable().default(null),
          update: productShortcode.nullable().optional(),
        },
      },
      {
        key: "subjectProductMode",
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
        key: "parentTaskId",
        kind: "identifier",
        nullable: true,
        reference: { entity: "task" },
        control: { kind: "specialized", renderer: "entity-select" },
        display: { columnGroup: "Dependencies" },
        validation: {
          read: taskShortcode.nullable(),
          create: taskShortcode.nullable().default(null),
          update: taskShortcode.nullable().optional(),
        },
      },
      {
        key: "due",
        kind: "dateRange",
        nullable: true,
        dateRange: {
          start: "dueDate",
          end: "dueEndDate",
          semantics: "deadline",
        },
        control: { kind: "dateRange" },
        display: {
          columnGroup: "Schedule",
          columnIdOverride: "dueDate",
          mobile: { slot: "meta", priority: 40, interactive: true },
        },
        validation: {
          read: storedDateRangeSchema.nullable(),
          create: dateRangeSchema.nullable().default(null),
          update: dateRangeSchema.nullable().optional(),
        },
      },
      { key: "dueDate", kind: "date", nullable: true },
      { key: "dueEndDate", kind: "date", nullable: true },
      {
        key: "trade",
        kind: "enum",
        // Storage is an override; the read projection remains required after
        // the resolver supplies parent/project defaults.
        nullable: true,
        control: {
          kind: "select",
          options: selectControlOptions.trade,
          suggest: {
            basis: ["name", "projectId"],
            rules: [TRADE_SUGGEST_RULE],
          },
        },
        display: {
          columnGroup: "Work",
          width: "sm",
          mobile: { slot: "meta", priority: 50 },
        },
        resolution: {
          reset: { trade: null },
          redundancy: "eligible",
          inherit: {
            from: [
              { hierarchy: { whileSame: "projectId" } },
              { path: "project.defaultTrade" },
            ],
          },
        },
        explanation: {
          ruleId: "task.effective-trade",
          description:
            "A task trade override wins; otherwise the nearest ancestor task on the same effective project, then that project's default trade, supplies it.",
          projections: {
            list: "fieldResolutions.trade.value",
            detail: "fieldResolutions.trade.value",
            summary: "fieldResolutions.trade.value",
          },
          sourceDependencies: [
            { path: "fieldResolutions.trade.sourceEntity", label: "Source" },
            {
              path: "fieldResolutions.trade.storedValue",
              label: "Stored override",
            },
            {
              path: "fieldResolutions.trade.fallbackValue",
              label: "Inherited value",
            },
          ],
        },
        validation: {
          read: tradeSchema,
          create: tradeSchema.nullable().default(null),
          update: tradeSchema.nullable().optional(),
        },
      },
      {
        key: "sortOrder",
        kind: "number",
        nullable: true,
        control: { kind: "number" },
        display: { detail: false, listHidden: true },
        validation: {
          read: z.number().nullable(),
          create: z.number().nullable().default(null),
          update: z.number().nullable().optional(),
        },
      },
      {
        key: "blockedByIds",
        kind: "identifier",
        reference: { entity: "task", multiple: true },
        control: { kind: "specialized", renderer: "entity-multi-select" },
        display: { list: false },
        validation: {
          read: z.array(taskShortcode),
          create: null,
          update: z.array(taskShortcode).optional(),
        },
      },
      {
        key: "pendingImageIds",
        kind: "identifier",
        reference: { entity: "image", multiple: true },
        validation: {
          read: null,
          create: z.array(imageShortcode).optional(),
          update: z.array(imageShortcode).optional(),
        },
      },
      {
        key: "removeImageIds",
        kind: "identifier",
        reference: { entity: "image", multiple: true },
        validation: {
          read: null,
          create: null,
          update: z.array(imageShortcode).optional(),
        },
      },
      {
        key: "imageOrder",
        semanticRole: "attachment",
        kind: "text",
        validation: {
          read: null,
          create: null,
          update: z.array(imageShortcode).optional(),
        },
      },
      {
        key: "images",
        kind: "json",
        display: { detail: false, standard: "image" },
        provenance: {
          kind: "derived",
          sources: [{ entity: "image", relation: "images" }],
        },
        explanation: {
          ruleId: "task.images",
          description:
            "Task images are the current live Image attachments in canonical attachment order; list and summary surfaces use the same selected images through the display-image projection.",
          projections: {
            list: "displayImages",
            detail: "images",
            summary: "displayImages",
          },
          sourceDependencies: [
            { path: "displayImages", label: "Selected task images" },
          ],
        },
        validation: { read: z.array(imageOut), create: null, update: null },
      },
      {
        display: { detail: false, list: false },
        key: "id",
        kind: "identifier",
        validation: {
          read: taskShortcode,
          create: null,
          update: null,
        },
      },
      {
        display: { detail: false, list: false },
        key: "projectName",
        kind: "text",
        nullable: true,
        validation: {
          read: z.string().nullable(),
          create: null,
          update: null,
        },
      },
      {
        display: { detail: false, list: false },
        key: "subjectProductName",
        kind: "text",
        nullable: true,
        validation: {
          read: z.string().nullable(),
          create: null,
          update: null,
        },
      },
      {
        display: { detail: false, list: false },
        key: "parentTaskName",
        kind: "text",
        nullable: true,
        validation: {
          read: z.string().nullable(),
          create: null,
          update: null,
        },
      },
      {
        key: "blockingIds",
        kind: "identifier",
        reference: { entity: "task", multiple: true },
        display: { list: false },
        validation: {
          read: z.array(taskShortcode),
          create: null,
          update: null,
        },
      },
      {
        display: { detail: false, list: false },
        key: "subtaskCount",
        kind: "number",
        validation: {
          read: z.number().int(),
          create: null,
          update: null,
        },
      },
      {
        display: { detail: false, list: false },
        key: "doneSubtaskCount",
        kind: "number",
        validation: {
          read: z.number().int(),
          create: null,
          update: null,
        },
      },
      {
        display: { detail: false, list: false },
        key: "createdAt",
        kind: "timestamp",
        validation: {
          read: z.date(),
          create: null,
          update: null,
        },
      },
      {
        display: { detail: false, list: false },
        key: "updatedAt",
        kind: "timestamp",
        validation: {
          read: z.date(),
          create: null,
          update: null,
        },
      },
      { key: "shortcode", kind: "text" },
      {
        key: "deletedAt",
        kind: "timestamp",
        nullable: true,
      },
    ],
    storage: [
      {
        key: "id",
        specialized: "primary-key:TaskId",
      },
      { key: "shortcode", specialized: "shortcode" },
      "name",
      {
        key: "status",
        defaultValue: "'not_started'",
        specialized: "enum:status",
      },
      { key: "projectId", reference: "project" },
      {
        key: "projectMode",
        defaultValue: "'inherit'",
        specialized: "enum:inheritance-mode",
      },
      { key: "assigneeId", reference: "ledgerParty" },
      {
        key: "assigneeMode",
        defaultValue: "'inherit'",
        specialized: "enum:inheritance-mode",
      },
      { key: "subjectProductId", reference: "product" },
      {
        key: "subjectProductMode",
        defaultValue: "'inherit'",
        specialized: "enum:inheritance-mode",
      },
      { key: "parentTaskId", reference: "task" },
      "dueDate",
      "dueEndDate",
      { key: "trade", specialized: "enum:trade" },
      { key: "sortOrder", specialized: "double-precision" },
      { key: "createdAt" },
      { key: "updatedAt", specialized: "updated-at" },
      "deletedAt",
    ],
    create: [
      "name",
      "status",
      "projectId",
      "projectMode",
      "subjectProductId",
      "subjectProductMode",
      "assigneeId",
      "assigneeMode",
      "parentTaskId",
      "due",
      "trade",
      "sortOrder",
      "pendingImageIds",
    ],
    update: [
      "name",
      "status",
      "projectId",
      "projectMode",
      "subjectProductId",
      "subjectProductMode",
      "assigneeId",
      "assigneeMode",
      "parentTaskId",
      "due",
      "trade",
      "sortOrder",
      "blockedByIds",
      "pendingImageIds",
      "removeImageIds",
      "imageOrder",
    ],
    audit: [
      "name",
      "status",
      "projectId",
      "projectMode",
      "subjectProductId",
      "subjectProductMode",
      "assigneeId",
      "assigneeMode",
      "parentTaskId",
      "due",
      "trade",
    ],
    derived: {
      // Effective references, inherited from a parent task, by name.
      projectId: { via: "project" },
      subjectProductId: { via: "subject" },
      assigneeId: { via: "assignee" },
      // Trade and due date, inherited from the parent task.
      effectiveTrade: { type: "text" },
      effectiveDueDate: { type: "date" },
      completion: { type: "enum", options: ["open", "done"] },
      topLevel: { type: "boolean" },
      subjectName: { via: "subject.name" },
    },
    sort: {
      fields: [
        "sortOrder",
        "name",
        "status",
        "dueDate",
        "trade",
        "projectId",
        "subjectProductId",
        "assigneeId",
        "createdAt",
        "updatedAt",
      ],
    },
    grouping: ["status", "projectId", "trade"],
    intents: {
      fields: {
        capture: [
          "name",
          "status",
          "projectId",
          "projectMode",
          "subjectProductId",
          "subjectProductMode",
          "assigneeId",
          "assigneeMode",
          "trade",
          "due",
          "pendingImageIds",
        ],
        full: [
          "name",
          "status",
          "projectId",
          "projectMode",
          "subjectProductId",
          "subjectProductMode",
          "assigneeId",
          "assigneeMode",
          "trade",
          "due",

          "notes",
          "pendingImageIds",
          "removeImageIds",
          "imageOrder",
        ],
        schedule: ["name", "status", "due"],
        status: ["status"],
        project: ["projectId"],
        subject: ["subjectProductId"],
      },
      create: ["capture", "full"],
      update: ["full", "schedule", "status", "project", "subject"],
      // `notes` is accepted by the canonical task inputs but is not a scalar
      // model field yet; the editor addresses it through the input contract.
      editorFields: ["notes"],
      // Rescheduling is the point of the schedule editor, so a date is
      // required there even though a task may be unscheduled.
      required: { schedule: ["due"] },
    },
    output: [
      "fieldResolutions",
      "assigneeId",
      "assigneeName",
      "id",
      "name",
      "status",
      "projectId",
      "subjectProductId",
      "parentTaskId",
      "due",
      "trade",
      "sortOrder",
      "projectName",
      "subjectProductName",
      "parentTaskName",
      "blockedByIds",
      "blockingIds",
      "subtaskCount",
      "doneSubtaskCount",
      "images",
      "createdAt",
      "updatedAt",
    ],
  },
  fields: {
    create: { module: "@cubby/schemas/project", export: "taskCreateInput" },
    update: { module: "@cubby/schemas/project", export: "taskUpdateData" },
    output: { module: "@cubby/schemas/project", export: "taskOut" },
    list: { module: "@cubby/schemas/project", export: "taskListItemOut" },
  },
  storage: {
    indexes: [{ on: ["status"] }, { on: ["dueDate"] }],
    relations: {
      assignee: "assigneeId",
      project: "projectId",
      subjectProduct: "subjectProductId",
      parentTask: { field: "parentTaskId", relationName: "TaskToTask" },
      subtasks: { many: "task", relationName: "TaskToTask" },
      images: { many: "entityAttachment" },
    },
  },
  filters: {
    audit: true,
    schema: { module: "@cubby/schemas/project", export: "taskFilterFields" },
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
        columnId: "name",
        field: "search",
        kind: "text",
        placeholder: "Search tasks...",
        deriveSchema: true,
        anyOf: ["name", "subjectName"],
      },
      {
        columnId: "status",
        kind: "multiselect",
        placeholder: "Filter by status...",
        deriveSchema: true,
        schemaRef: {
          module: "@cubby/schemas/task-fields",
          export: "taskStatusSchema",
        },
        options: [
          {
            value: "not_started",
            label: "Not started",
            color: "var(--chart-neutral)",
          },
          { value: "later", label: "Later", color: "var(--chart-2)" },
          {
            value: "in_progress",
            label: "In progress",
            color: "var(--chart-1)",
          },
          {
            value: "blocked",
            label: "Blocked",
            color: "var(--chart-negative)",
          },
          { value: "done", label: "Done", color: "var(--chart-positive)" },
        ],
      },
      {
        columnId: "trade",
        kind: "multiselect",
        placeholder: "Filter by trade...",
        deriveSchema: true,
        derived: "effectiveTrade",
        schemaRef: {
          module: "@cubby/schemas/task-fields",
          export: "tradeSchema",
        },
        optionsRef: {
          module: "~/entity/presentation/trade-options",
          export: "tradeOptions",
        },
      },
      {
        columnId: "dueDate",
        kind: "range",
        wire: {
          kind: "range",
          from: "dueFrom",
          to: "dueTo",
          presence: "duePresenceFilter",
        },
        derived: "effectiveDueDate",
        placeholder: "Filter by due date...",
        options: [
          { value: "has", label: "Has due date", meta: true },
          { value: "none", label: "(none)", meta: true },
          { value: "overdue", label: "Overdue" },
          { value: "week", label: "Due this week" },
          { value: "30d", label: "Due in 30 days" },
        ],
        expandRef: {
          module: "~/entity/filter-behavior",
          export: "resolveTaskDueFilter",
        },
      },
      {
        columnId: "completion",
        kind: "multiselect",
        placeholder: "Filter task completion...",
        options: [
          { value: "open", label: "Open" },
          { value: "done", label: "Done" },
        ],
      },
      {
        columnId: "projectId",
        urlKey: "project",
        field: "projectId",
        kind: "idMulti",
        placeholder: "Filter by project...",
        optionsKey: "project",
        brandRef: { entity: "project" },
      },
      {
        columnId: "productId",
        field: "subjectProductId",
        urlKey: "productId",
        kind: "idMulti",
        placeholder: "Filter by product id...",
        brandRef: { entity: "product" },
      },
      {
        columnId: "subjectProductId",
        urlKey: "subjectProduct",
        field: "subjectProductId",
        kind: "idMulti",
        placeholder: "Filter by product...",
        optionsKey: "taskProducts",
        brandRef: { entity: "product" },
      },
      {
        columnId: "parentTaskId",
        urlKey: "parentTask",
        field: "parentTaskId",
        kind: "idMulti",
        placeholder: "Filter by parent task...",
        optionsKey: "parentTask",
        brandRef: { entity: "task" },
        nullable: { field: "parentTaskPresenceFilter", label: "parent task" },
      },
      {
        // The task board and actionable list read top-level tasks only.
        columnId: "topLevelOnly",
        kind: "boolean",
        placeholder: "Top-level tasks only",
        derived: "topLevel",
      },
      {
        columnId: "related:task.blockedBy",
        field: "blockedByTaskSearch",
        urlKey: "related-blockedByTask",
        kind: "text",
        placeholder: "Search related blocked by...",
      },
      {
        columnId: "blockedByTaskId",
        kind: "idMulti",
        placeholder: "Filter by related blocked by id...",
        brandRef: { entity: "task" },
      },
      {
        columnId: "blockedByTaskPresenceFilter",
        kind: "presence",
        placeholder: "Filter related blocked by presence...",
      },
      {
        columnId: "related:task.parent",
        field: "parentTaskSearch",
        urlKey: "related-parentTask",
        kind: "text",
        placeholder: "Search related parent task...",
      },
      {
        columnId: "relatedParentTaskId",
        field: "parentTaskId",
        urlKey: "parentTaskId",
        wire: { kind: "param", name: "parentTaskId" },
        kind: "idMulti",
        placeholder: "Filter by related parent task id...",
        brandRef: { entity: "task" },
      },
      {
        columnId: "parentTaskPresenceFilter",
        kind: "presence",
        placeholder: "Filter related parent task presence...",
      },
    ],
  },
  relations: [
    {
      key: "assignee",
      label: "Assignee",
      target: "ledgerParty",
      cardinality: "one",
      provenance: {
        kind: "local-path",
        steps: [{ edge: "Task.assigneeId", direction: "outgoing" }],
      },
      inverse: { steps: [{ edge: "Task.assigneeId", direction: "incoming" }] },
    },
    {
      key: "subtasks",
      label: "Subtasks",
      target: "task",
      cardinality: "many",
      provenance: {
        kind: "local-path",
        steps: [{ edge: "Task.parentTaskId", direction: "incoming" }],
      },
      inverse: {
        steps: [{ edge: "Task.parentTaskId", direction: "outgoing" }],
      },
    },
    {
      key: "project",
      label: "Project",
      target: "project",
      cardinality: "one",
      provenance: {
        kind: "local-path",
        steps: [{ edge: "Task.projectId", direction: "outgoing" }],
      },
      inverse: { steps: [{ edge: "Task.projectId", direction: "incoming" }] },
    },
    {
      key: "subject",
      label: "Subject product",
      target: "product",
      cardinality: "one",
      provenance: {
        kind: "local-path",
        steps: [{ edge: "Task.subjectProductId", direction: "outgoing" }],
      },
      inverse: {
        steps: [{ edge: "Task.subjectProductId", direction: "incoming" }],
      },
    },
    {
      key: "parent",
      label: "Parent task",
      target: "task",
      cardinality: "one",
      provenance: {
        kind: "local-path",
        steps: [{ edge: "Task.parentTaskId", direction: "outgoing" }],
      },
      inverse: {
        steps: [{ edge: "Task.parentTaskId", direction: "incoming" }],
      },
    },
    {
      key: "blocked-by",
      label: "Blocked by",
      target: "task",
      cardinality: "many",
      provenance: {
        kind: "local-path",
        steps: [
          { edge: "EntityLink[taskDependency].from", direction: "incoming" },
          { edge: "EntityLink[taskDependency].to", direction: "outgoing" },
        ],
      },
      inverse: {
        steps: [
          { edge: "EntityLink[taskDependency].to", direction: "incoming" },
          { edge: "EntityLink[taskDependency].from", direction: "outgoing" },
        ],
      },
    },
    {
      key: "images",
      label: "Images",
      target: "image",
      cardinality: "many",
      provenance: {
        kind: "local-path",
        steps: [
          { edge: "EntityAttachment.entityId", direction: "incoming" },
          { edge: "EntityAttachment.imageId", direction: "outgoing" },
        ],
      },
      inverse: {
        steps: [
          { edge: "EntityAttachment.imageId", direction: "incoming" },
          { edge: "EntityAttachment.entityId", direction: "outgoing" },
        ],
      },
    },
  ],
  // Related rows the search document reads (ADR 0021).
  search: {
    mode: "semantic",
    // Subtasks (one level) inherit their parent's project and subject.
    inputs: [
      ...imageDescriptionInputs("task"),

      { table: "Task", match: { id: "id" }, path: [SUBTASKS] },
      { table: "Project", match: { id: "projectId" } },
      {
        table: "Project",
        match: { id: "id" },
        path: [{ table: "Task", from: "projectId", to: "id" }, SUBTASKS],
      },
      { table: "Product", match: { id: "subjectProductId" } },
      {
        table: "Product",
        match: { id: "id" },
        path: [{ table: "Task", from: "subjectProductId", to: "id" }, SUBTASKS],
      },
    ],
  },
  capabilities: {
    timeline: "default",
    images: {
      storage: imageAssociationStorage.shape.task.value,
      displaySources: [
        {
          relationPath: ["subject"],
        },
        {
          relationPath: ["project"],
        },
      ],
      ingress: [
        { kind: "self", routeId: "task-self", choice: "primary" },
        { kind: "createSelf", routeId: "task-new", enabled: true },
      ],
      routing: {
        category: "home",
        candidateFields: ["name"],
        temporalFields: ["due.start", "due.end"],
        lifecycleFilters: [
          {
            field: "status",
            oneOf: ["not_started", "later", "in_progress", "blocked"],
          },
        ],
        signals: {
          ocrFields: ["name"],
          classifierLabels: ["sticky_note"],
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
          path: [{ table: "Task", from: "projectId", to: "id" }],
        },
        {
          table: "Purchase",
          match: { id: "id" },
          columns: ["vendorId", "defaultProjectId", "deletedAt"],
          path: [
            { table: "Expense", from: "purchaseId", to: "projectId" },
            { table: "Task", from: "projectId", to: "id" },
          ],
        },
        {
          table: "ProductCategory",
          match: { id: "id" },
          columns: ["feature", "parentId", "deletedAt"],
          path: [
            { table: "Product", from: "categoryId", to: "id" },
            { table: "Expense", from: "productId", to: "projectId" },
            { table: "Task", from: "projectId", to: "id" },
          ],
        },

        {
          table: "Product",
          match: { id: "id" },
          columns: ["deletedAt", "id"],
          path: [
            { table: "Task", from: "subjectProductId", to: "id" },
            { table: "Task", from: "parentTaskId", to: "id" },
          ],
        },
        {
          table: "EntityAttachment",
          match: { entityId: "id" },
          columns: ["deletedAt", "imageId", "purpose", "role"],
          path: [
            { table: "Product", from: "id", to: "id" },
            { table: "Task", from: "subjectProductId", to: "id" },
            { table: "Task", from: "parentTaskId", to: "id" },
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
            { table: "Task", from: "subjectProductId", to: "id" },
            { table: "Task", from: "parentTaskId", to: "id" },
          ],
        },
        {
          table: "Project",
          match: { id: "id" },
          columns: ["deletedAt", "id"],
          path: [
            { table: "Task", from: "projectId", to: "id" },
            { table: "Task", from: "parentTaskId", to: "id" },
          ],
        },
        {
          table: "EntityAttachment",
          match: { entityId: "id" },
          columns: ["deletedAt", "imageId", "purpose", "role"],
          path: [
            { table: "Project", from: "id", to: "id" },
            { table: "Task", from: "projectId", to: "id" },
            { table: "Task", from: "parentTaskId", to: "id" },
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
            { table: "Project", from: "id", to: "id" },
            { table: "Task", from: "projectId", to: "id" },
            { table: "Task", from: "parentTaskId", to: "id" },
          ],
        },
        {
          table: "Product",
          match: { id: "id" },
          columns: ["deletedAt", "brandId"],
          path: [
            { table: "Task", from: "subjectProductId", to: "id" },
            { table: "Task", from: "parentTaskId", to: "id" },
          ],
        },
        {
          table: "Vendor",
          match: { id: "id" },
          columns: ["deletedAt", "id"],
          path: [
            { table: "Product", from: "brandId", to: "id" },
            { table: "Task", from: "subjectProductId", to: "id" },
            { table: "Task", from: "parentTaskId", to: "id" },
          ],
        },
        {
          table: "EntityAttachment",
          match: { entityId: "id" },
          columns: ["deletedAt", "imageId", "purpose", "role"],
          path: [
            { table: "Vendor", from: "id", to: "id" },
            { table: "Product", from: "brandId", to: "id" },
            { table: "Task", from: "subjectProductId", to: "id" },
            { table: "Task", from: "parentTaskId", to: "id" },
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
            { table: "Task", from: "subjectProductId", to: "id" },
            { table: "Task", from: "parentTaskId", to: "id" },
          ],
        },
        {
          table: "Task",
          match: { projectId: "id" },
          columns: ["deletedAt", "subjectProductId"],
          path: [
            { table: "Project", from: "id", to: "id" },
            { table: "Task", from: "projectId", to: "id" },
            { table: "Task", from: "parentTaskId", to: "id" },
          ],
        },
        {
          table: "Product",
          match: { id: "id" },
          columns: ["deletedAt", "id"],
          path: [
            { table: "Task", from: "subjectProductId", to: "projectId" },
            { table: "Project", from: "id", to: "id" },
            { table: "Task", from: "projectId", to: "id" },
            { table: "Task", from: "parentTaskId", to: "id" },
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
            { table: "Task", from: "projectId", to: "id" },
            { table: "Task", from: "parentTaskId", to: "id" },
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
            { table: "Task", from: "projectId", to: "id" },
            { table: "Task", from: "parentTaskId", to: "id" },
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
          path: [
            { table: "Project", from: "id", to: "id" },
            { table: "Task", from: "projectId", to: "id" },
            { table: "Task", from: "parentTaskId", to: "id" },
          ],
        },
        {
          table: "Product",
          match: { id: "id" },
          columns: ["deletedAt", "id"],
          path: [
            { table: "Expense", from: "productId", to: "projectId" },
            { table: "Project", from: "id", to: "id" },
            { table: "Task", from: "projectId", to: "id" },
            { table: "Task", from: "parentTaskId", to: "id" },
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
            { table: "Task", from: "projectId", to: "id" },
            { table: "Task", from: "parentTaskId", to: "id" },
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
            { table: "Task", from: "projectId", to: "id" },
            { table: "Task", from: "parentTaskId", to: "id" },
          ],
        },
        {
          table: "EntityLink",
          match: { fromEntityId: "id" },
          columns: ["deletedAt", "toEntityId"],
          path: [
            { table: "Project", from: "id", to: "id" },
            { table: "Task", from: "projectId", to: "id" },
            { table: "Task", from: "parentTaskId", to: "id" },
          ],
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
            { table: "Task", from: "projectId", to: "id" },
            { table: "Task", from: "parentTaskId", to: "id" },
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
            { table: "Task", from: "projectId", to: "id" },
            { table: "Task", from: "parentTaskId", to: "id" },
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
            { table: "Task", from: "projectId", to: "id" },
            { table: "Task", from: "parentTaskId", to: "id" },
          ],
        },
        {
          table: "Product",
          match: { id: "id" },
          columns: ["deletedAt", "brandId"],
          path: [
            { table: "Task", from: "subjectProductId", to: "projectId" },
            { table: "Project", from: "id", to: "id" },
            { table: "Task", from: "projectId", to: "id" },
            { table: "Task", from: "parentTaskId", to: "id" },
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
            { table: "Task", from: "projectId", to: "id" },
            { table: "Task", from: "parentTaskId", to: "id" },
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
            { table: "Task", from: "projectId", to: "id" },
            { table: "Task", from: "parentTaskId", to: "id" },
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
            { table: "Task", from: "projectId", to: "id" },
            { table: "Task", from: "parentTaskId", to: "id" },
          ],
        },
        {
          table: "Product",
          match: { id: "id" },
          columns: ["deletedAt", "brandId"],
          path: [
            { table: "Expense", from: "productId", to: "projectId" },
            { table: "Project", from: "id", to: "id" },
            { table: "Task", from: "projectId", to: "id" },
            { table: "Task", from: "parentTaskId", to: "id" },
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
            { table: "Task", from: "projectId", to: "id" },
            { table: "Task", from: "parentTaskId", to: "id" },
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
            { table: "Task", from: "projectId", to: "id" },
            { table: "Task", from: "parentTaskId", to: "id" },
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
            { table: "Task", from: "projectId", to: "id" },
            { table: "Task", from: "parentTaskId", to: "id" },
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
            { table: "Task", from: "projectId", to: "id" },
            { table: "Task", from: "parentTaskId", to: "id" },
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
            { table: "Task", from: "projectId", to: "id" },
            { table: "Task", from: "parentTaskId", to: "id" },
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
            { table: "Task", from: "projectId", to: "id" },
            { table: "Task", from: "parentTaskId", to: "id" },
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
            { table: "Task", from: "projectId", to: "id" },
            { table: "Task", from: "parentTaskId", to: "id" },
          ],
        },

        {
          table: "Task",
          match: { id: "id" },
          columns: [
            "trade",
            "projectId",
            "subjectProductId",
            "parentTaskId",
            "deletedAt",
          ],
          path: [{ table: "Task", from: "parentTaskId", to: "id" }],
        },
        {
          table: "Project",
          match: { id: "projectId" },
          columns: ["defaultTrade", "parentProjectId", "deletedAt"],
        },
        {
          table: "Project",
          match: { id: "id" },
          columns: ["defaultTrade", "parentProjectId", "deletedAt"],
          path: [
            { table: "Task", from: "projectId", to: "id" },
            { table: "Task", from: "parentTaskId", to: "id" },
          ],
        },

        {
          table: "Product",
          match: { id: "id" },
          columns: ["deletedAt", "id"],
          path: [{ table: "Task", from: "subjectProductId", to: "id" }],
        },
        {
          table: "EntityAttachment",
          match: { entityId: "id" },
          columns: ["deletedAt", "imageId", "purpose", "role"],
          path: [
            { table: "Product", from: "id", to: "id" },
            { table: "Task", from: "subjectProductId", to: "id" },
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
            { table: "Task", from: "subjectProductId", to: "id" },
          ],
        },
        {
          table: "Project",
          match: { id: "id" },
          columns: ["deletedAt", "id"],
          path: [{ table: "Task", from: "projectId", to: "id" }],
        },
        {
          table: "EntityAttachment",
          match: { entityId: "id" },
          columns: ["deletedAt", "imageId", "purpose", "role"],
          path: [
            { table: "Project", from: "id", to: "id" },
            { table: "Task", from: "projectId", to: "id" },
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
            { table: "Project", from: "id", to: "id" },
            { table: "Task", from: "projectId", to: "id" },
          ],
        },
        {
          table: "Product",
          match: { id: "id" },
          columns: ["deletedAt", "brandId"],
          path: [{ table: "Task", from: "subjectProductId", to: "id" }],
        },
        {
          table: "Vendor",
          match: { id: "id" },
          columns: ["deletedAt", "id"],
          path: [
            { table: "Product", from: "brandId", to: "id" },
            { table: "Task", from: "subjectProductId", to: "id" },
          ],
        },
        {
          table: "EntityAttachment",
          match: { entityId: "id" },
          columns: ["deletedAt", "imageId", "purpose", "role"],
          path: [
            { table: "Vendor", from: "id", to: "id" },
            { table: "Product", from: "brandId", to: "id" },
            { table: "Task", from: "subjectProductId", to: "id" },
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
            { table: "Task", from: "subjectProductId", to: "id" },
          ],
        },
        {
          table: "Task",
          match: { projectId: "id" },
          columns: ["deletedAt", "subjectProductId"],
          path: [
            { table: "Project", from: "id", to: "id" },
            { table: "Task", from: "projectId", to: "id" },
          ],
        },
        {
          table: "Product",
          match: { id: "id" },
          columns: ["deletedAt", "id"],
          path: [
            { table: "Task", from: "subjectProductId", to: "projectId" },
            { table: "Project", from: "id", to: "id" },
            { table: "Task", from: "projectId", to: "id" },
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
            { table: "Task", from: "projectId", to: "id" },
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
            { table: "Task", from: "projectId", to: "id" },
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
          path: [
            { table: "Project", from: "id", to: "id" },
            { table: "Task", from: "projectId", to: "id" },
          ],
        },
        {
          table: "Product",
          match: { id: "id" },
          columns: ["deletedAt", "id"],
          path: [
            { table: "Expense", from: "productId", to: "projectId" },
            { table: "Project", from: "id", to: "id" },
            { table: "Task", from: "projectId", to: "id" },
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
            { table: "Task", from: "projectId", to: "id" },
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
            { table: "Task", from: "projectId", to: "id" },
          ],
        },
        {
          table: "EntityLink",
          match: { fromEntityId: "id" },
          columns: ["deletedAt", "toEntityId"],
          path: [
            { table: "Project", from: "id", to: "id" },
            { table: "Task", from: "projectId", to: "id" },
          ],
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
            { table: "Task", from: "projectId", to: "id" },
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
            { table: "Task", from: "projectId", to: "id" },
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
            { table: "Task", from: "projectId", to: "id" },
          ],
        },
        {
          table: "Product",
          match: { id: "id" },
          columns: ["deletedAt", "brandId"],
          path: [
            { table: "Task", from: "subjectProductId", to: "projectId" },
            { table: "Project", from: "id", to: "id" },
            { table: "Task", from: "projectId", to: "id" },
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
            { table: "Task", from: "projectId", to: "id" },
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
            { table: "Task", from: "projectId", to: "id" },
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
            { table: "Task", from: "projectId", to: "id" },
          ],
        },
        {
          table: "Product",
          match: { id: "id" },
          columns: ["deletedAt", "brandId"],
          path: [
            { table: "Expense", from: "productId", to: "projectId" },
            { table: "Project", from: "id", to: "id" },
            { table: "Task", from: "projectId", to: "id" },
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
            { table: "Task", from: "projectId", to: "id" },
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
            { table: "Task", from: "projectId", to: "id" },
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
            { table: "Task", from: "projectId", to: "id" },
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
            { table: "Task", from: "projectId", to: "id" },
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
            { table: "Task", from: "projectId", to: "id" },
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
            { table: "Task", from: "projectId", to: "id" },
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
            { table: "Task", from: "projectId", to: "id" },
          ],
        },
      ],

      checks: [
        {
          id: "task_due_range",
          satisfiedLabel: "Due window in order",
          placement: { field: "due" },
          facet: "integrity",
          kind: "defect",
          weight: 2,
          scoreCap: 49,
          label: "Due window",
          message: "The due window ends before it starts.",
        },
        {
          id: "task_trade",
          satisfiedLabel: "Trade recorded",
          placement: { field: "trade" },
          facet: "identity",
          weight: 1,
          label: "Trade",
          message: "No trade is recorded or inherited for this task.",
        },
      ],
    },
  },
  extensions: {
    ports: {
      repository: {
        module: "~/server/domains/task/repo/repository",
        export: "taskRepository",
      },
      search: "document",
    },
  },
});
