import { defineEntity } from "./definition.js";
import { plainDate } from "@cubby/schemas/base-entity";
import {
  imageShortcode,
  productShortcode,
  projectShortcode,
  taskShortcode,
} from "../identifier-fields.js";
import { taskStatusSchema, tradeSchema } from "@cubby/schemas/task-fields";
import { optionalFieldResolutionsSchema } from "@cubby/schemas/field-resolution";
import { imageOut } from "./field-primitives.js";
import { z } from "zod";
const inheritanceModeSchema = z.enum(["inherit", "explicit"]);
export default defineEntity({
  key: "task",
  names: { singular: "Task", plural: "Tasks" },
  route: { basePath: "tasks", create: "dialog", list: true, detail: true },
  table: "Task",
  identifiers: { brand: "TaskId", shortcode: "TSK-" },
  presentation: {
    titleField: "name",
    domain: "house",
    description: "Concrete work, schedules, and completion state.",
    emptyState: {
      title: "No tasks yet",
      description:
        "Break a project down into steps, or jot down a one-off to get to later.",
      actionLabel: "New Task",
    },
    icons: { lucide: "ListChecks", sfSymbol: "checklist", emoji: "✅" },
    detail: {
      hero: {
        chip: "status",
        actions: ["edit", "bulkEdit", "delete"],
      },
      sections: [
        {
          kind: "fields",
          id: "overview",
          title: "Overview",
          placement: "supporting",
          fields: [
            "name",
            "status",
            "trade",
            "dueDate",
            "dueEndDate",
            "projectId",
            "subjectProductId",
            "parentTaskId",
          ],
        },
        {
          kind: "fields",
          id: "dependencies",
          title: "Dependencies",
          placement: "supporting",
          fields: ["blockedByIds", "blockingIds"],
        },
        {
          kind: "relation",
          id: "subtasks",
          title: "Subtasks",
          relation: "subtasks",
          filter: { descriptor: "parentTask" },
          columns: ["name", "status", "dueDate"],
        },
      ],
    },
    list: {
      views: [
        "table",
        { kind: "slot", id: "agenda", label: "Next" },
        {
          kind: "slot",
          id: "board",
          label: "Board",
          searchKeys: ["cols", "lane", "q"],
        },
        "timeline",
      ],
      actions: ["bulkEdit", "delete"],
      timeline: {
        fields: ["dueDate", "dueEndDate"],
        lifecycle: {
          start: "createdAt",
          milestones: ["dueDate"],
          end: "dueEndDate",
        },
      },
    },
  },
  model: {
    fields: [
      {
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
        display: { list: true, detail: true, standard: "name", detailOrder: 0 },
        validation: {
          read: z.string().min(1),
          create: z.string().min(1),
          update: z.string().min(1).optional(),
        },
      },
      {
        key: "status",
        kind: "enum",
        control: { kind: "select" },
        display: {
          list: true,
          detail: true,
          detailOrder: 1,
          width: "sm",
          mobile: { slot: "subtitle", priority: 10 },
        },
        validation: {
          read: taskStatusSchema,
          create: taskStatusSchema.default("not_started"),
          update: taskStatusSchema.optional(),
        },
      },
      {
        key: "projectId",
        kind: "identifier",
        nullable: true,
        label: "Project",
        reference: { entity: "project" },
        control: {
          kind: "specialized",
          renderer: "entity-select",
          suggest: { basis: ["name"] },
        },
        display: {
          list: true,
          detail: true,
          detailOrder: 5,
          columnId: "project",
        },
        resolution: {
          reset: { projectMode: "inherit", projectId: null },
          none: { projectMode: "explicit", projectId: null },
          redundancy: "eligible",
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
        readKey: null,
        validation: {
          read: null,
          create: inheritanceModeSchema.optional(),
          update: inheritanceModeSchema.optional(),
        },
      },
      {
        key: "subjectProductId",
        kind: "identifier",
        nullable: true,
        label: "For",
        reference: { entity: "product" },
        control: {
          kind: "specialized",
          renderer: "entity-select",
          suggest: { basis: ["name"] },
        },
        display: {
          list: true,
          detail: true,
          detailOrder: 6,
          columnId: "subjectProduct",
        },
        resolution: {
          reset: { subjectProductMode: "inherit", subjectProductId: null },
          none: { subjectProductMode: "explicit", subjectProductId: null },
          redundancy: "eligible",
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
        readKey: null,
        validation: {
          read: null,
          create: inheritanceModeSchema.optional(),
          update: inheritanceModeSchema.optional(),
        },
      },
      {
        key: "parentTaskId",
        kind: "identifier",
        nullable: true,
        label: "Parent Task",
        reference: { entity: "task" },
        control: { kind: "specialized", renderer: "entity-select" },
        display: {
          list: true,
          detail: true,
          detailOrder: 7,
          columnId: "parentTask",
        },
        validation: {
          read: taskShortcode.nullable(),
          create: taskShortcode.nullable().default(null),
          update: taskShortcode.nullable().optional(),
        },
      },
      {
        key: "dueDate",
        kind: "date",
        nullable: true,
        label: "Due",
        control: { kind: "date", section: "schedule" },
        display: {
          list: true,
          detail: true,
          detailOrder: 3,
          width: "sm",
          format: "plainDate",
          mobile: { slot: "meta", priority: 40, interactive: true },
        },
        validation: {
          read: plainDate.nullable(),
          create: plainDate.nullable().default(null),
          update: plainDate.nullable().optional(),
        },
      },
      {
        key: "dueEndDate",
        kind: "date",
        nullable: true,
        label: "Due end",
        control: { kind: "date", section: "schedule" },
        display: { list: true, detail: true, detailOrder: 4, listHidden: true },
        validation: {
          read: plainDate.describe("End of a due-date range").nullable(),
          create: plainDate
            .describe("End of a due-date range")
            .nullable()
            .default(null),
          update: plainDate
            .describe("End of a due-date range")
            .nullable()
            .optional(),
        },
      },
      {
        key: "trade",
        kind: "enum",
        // Storage is an override; the read projection remains required after
        // the resolver supplies parent/project defaults.
        nullable: true,
        control: {
          kind: "select",
          suggest: { basis: ["name", "projectId"] },
        },
        display: {
          list: true,
          detail: true,
          detailOrder: 2,
          width: "sm",
          mobile: { slot: "meta", priority: 50 },
        },
        resolution: {
          reset: { trade: null },
          redundancy: "eligible",
        },
        explanation: {
          ruleId: "task.effective-trade",
          description:
            "A task trade override wins; otherwise the matching parent task or project default supplies it.",
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
        control: { kind: "number", section: "ordering" },
        display: { list: true, listHidden: true },
        validation: {
          read: z.number().nullable(),
          create: z.number().nullable().default(null),
          update: z.number().nullable().optional(),
        },
      },
      {
        key: "blockedByIds",
        kind: "identifier",
        label: "Blocked by",
        reference: { entity: "task", multiple: true },
        control: { kind: "specialized", renderer: "entity-multi-select" },
        display: { detail: true },
        validation: {
          read: z.array(taskShortcode),
          create: null,
          update: z.array(taskShortcode).optional(),
        },
      },
      {
        key: "pendingImageIds",
        kind: "identifier",
        readKey: null,
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
        readKey: null,
        reference: { entity: "image", multiple: true },
        validation: {
          read: null,
          create: null,
          update: z.array(imageShortcode).optional(),
        },
      },
      {
        key: "imageOrder",
        kind: "text",
        readKey: null,
        validation: {
          read: null,
          create: null,
          update: z.array(imageShortcode).optional(),
        },
      },
      {
        key: "images",
        kind: "json",
        display: { list: true, standard: "image", columnId: "image" },
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
        key: "id",
        kind: "identifier",
        validation: {
          read: taskShortcode,
          create: null,
          update: null,
        },
      },
      {
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
        label: "Blocks",
        reference: { entity: "task", multiple: true },
        display: { detail: true },
        validation: {
          read: z.array(taskShortcode),
          create: null,
          update: null,
        },
      },
      {
        key: "subtaskCount",
        kind: "number",
        validation: {
          read: z.number().int(),
          create: null,
          update: null,
        },
      },
      {
        key: "doneSubtaskCount",
        kind: "number",
        validation: {
          read: z.number().int(),
          create: null,
          update: null,
        },
      },
      {
        key: "createdAt",
        kind: "timestamp",
        validation: {
          read: z.date(),
          create: null,
          update: null,
        },
      },
      {
        key: "updatedAt",
        kind: "timestamp",
        validation: {
          read: z.date(),
          create: null,
          update: null,
        },
      },
      { key: "shortcode", kind: "text", readKey: null },
      {
        key: "notionPageId",
        kind: "text",
        nullable: true,
        label: "Notion Page ID",
        readKey: null,
      },
      { key: "deletedAt", kind: "timestamp", nullable: true, readKey: null },
    ],
    storage: [
      { key: "id", default: "generated", specialized: "primary-key:TaskId" },
      { key: "shortcode", specialized: "shortcode" },
      "name",
      {
        key: "status",
        default: "literal",
        defaultValue: "'not_started'",
        specialized: "enum:status",
      },
      { key: "projectId", reference: "project" },
      {
        key: "projectMode",
        default: "literal",
        defaultValue: "'inherit'",
        specialized: "enum:projectMode",
      },
      { key: "subjectProductId", reference: "product" },
      {
        key: "subjectProductMode",
        default: "literal",
        defaultValue: "'inherit'",
        specialized: "enum:subjectProductMode",
      },
      { key: "parentTaskId", reference: "task" },
      "dueDate",
      "dueEndDate",
      { key: "trade", specialized: "enum:trade" },
      { key: "sortOrder", specialized: "double-precision" },
      "notionPageId",
      { key: "createdAt", default: "now" },
      { key: "updatedAt", default: "now", specialized: "updated-at" },
      "deletedAt",
    ],
    create: [
      "name",
      "status",
      "projectId",
      "projectMode",
      "subjectProductId",
      "subjectProductMode",
      "parentTaskId",
      "dueDate",
      "dueEndDate",
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
      "parentTaskId",
      "dueDate",
      "dueEndDate",
      "trade",
      "sortOrder",
      "blockedByIds",
      "pendingImageIds",
      "removeImageIds",
      "imageOrder",
    ],
    bulk: [
      "projectId",
      "projectMode",
      "status",
      "trade",
      "dueDate",
      "dueEndDate",
    ],
    audit: [
      "name",
      "status",
      "projectId",
      "projectMode",
      "subjectProductId",
      "subjectProductMode",
      "parentTaskId",
      "dueDate",
      "dueEndDate",
      "trade",
    ],
    sort: {
      fields: [
        "name",
        "status",
        "dueDate",
        "trade",
        "project",
        "subjectProduct",
        "createdAt",
        "updatedAt",
      ],
      default: "createdAt",
      computed: ["project", "subjectProduct"],
      groupable: ["status"],
    },
    intents: {
      fields: {
        capture: [
          "name",
          "status",
          "projectId",
          "projectMode",
          "subjectProductId",
          "subjectProductMode",
          "trade",
          "dueDate",
          "pendingImageIds",
        ],
        full: [
          "name",
          "status",
          "projectId",
          "projectMode",
          "subjectProductId",
          "subjectProductMode",
          "trade",
          "dueDate",
          "dueEndDate",
          "notes",
          "pendingImageIds",
          "removeImageIds",
          "imageOrder",
        ],
        schedule: ["name", "status", "dueDate", "dueEndDate"],
        status: ["status"],
        project: ["projectId"],
        subject: ["subjectProductId"],
      },
      create: ["capture", "full"],
      update: ["full", "schedule", "status", "project", "subject"],
      // `notes` is accepted by the canonical task inputs but is not a scalar
      // model field yet; the editor addresses it through the input contract.
      editorFields: ["notes"],
    },
    output: [
      "fieldResolutions",
      "id",
      "name",
      "status",
      "projectId",
      "subjectProductId",
      "parentTaskId",
      "dueDate",
      "dueEndDate",
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
  filters: {
    audit: true,
    schema: { module: "@cubby/schemas/project", export: "taskFilterFields" },
    descriptors: [
      {
        columnId: "name",
        field: "search",
        kind: "text",
        placeholder: "Search tasks...",
        deriveSchema: true,
      },
      {
        columnId: "status",
        kind: "multiselect",
        placeholder: "Filter by status...",
        deriveSchema: true,
        stored: true,
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
        schemaRef: {
          module: "@cubby/schemas/task-fields",
          export: "tradeSchema",
        },
        optionsRef: {
          module: "~/app/projects/trade-options",
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
        placeholder: "Filter by due date...",
        options: [
          { value: "has", label: "Has due date", meta: true },
          { value: "none", label: "(none)", meta: true },
          { value: "overdue", label: "Overdue" },
          { value: "week", label: "Due this week" },
          { value: "30d", label: "Due in 30 days" },
        ],
        expandRef: {
          module: "~/entities/filter-behavior",
          export: "resolveTaskDueFilter",
        },
      },
      {
        columnId: "dueRelative",
        kind: "select",
        placeholder: "Filter by relative due date...",
        options: [{ value: "beforeToday", label: "Before today" }],
        urlOnly: true,
      },
      {
        columnId: "completion",
        kind: "select",
        placeholder: "Filter task completion...",
        options: [
          { value: "open", label: "Open" },
          { value: "done", label: "Done" },
        ],
        urlOnly: true,
      },
      {
        columnId: "project",
        field: "projectId",
        kind: "idMulti",
        placeholder: "Filter by project...",
        optionsKey: "project",
        brandRef: { entity: "project" },
        nullable: { field: "projectPresenceFilter", label: "project" },
      },
      {
        columnId: "productId",
        field: "subjectProductId",
        urlKey: "productId",
        kind: "id",
        placeholder: "Filter by product id...",
        brandRef: { entity: "product" },
        urlOnly: true,
      },
      {
        columnId: "subjectProduct",
        field: "subjectProductId",
        kind: "idMulti",
        placeholder: "Filter by product...",
        optionsKey: "taskProducts",
        brandRef: { entity: "product" },
        nullable: { field: "subjectProductPresenceFilter", label: "product" },
      },
      {
        columnId: "parentTask",
        field: "parentTaskId",
        kind: "idMulti",
        placeholder: "Filter by parent task...",
        optionsKey: "parentTask",
        brandRef: { entity: "task" },
        nullable: { field: "parentTaskPresenceFilter", label: "parent task" },
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
        urlOnly: true,
      },
      {
        columnId: "blockedByTaskPresenceFilter",
        kind: "presence",
        placeholder: "Filter related blocked by presence...",
        urlOnly: true,
      },
      {
        columnId: "related:task.parent",
        field: "parentTaskSearch",
        urlKey: "related-parentTask",
        kind: "text",
        placeholder: "Search related parent task...",
      },
      {
        columnId: "parentTaskId",
        kind: "idMulti",
        placeholder: "Filter by related parent task id...",
        urlOnly: true,
      },
      {
        columnId: "parentTaskPresenceFilter",
        kind: "presence",
        placeholder: "Filter related parent task presence...",
        urlOnly: true,
      },
    ],
  },
  relations: [
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
          { edge: "TaskDependency.taskId", direction: "incoming" },
          { edge: "TaskDependency.blockedByTaskId", direction: "outgoing" },
        ],
      },
      inverse: {
        steps: [
          { edge: "TaskDependency.blockedByTaskId", direction: "incoming" },
          { edge: "TaskDependency.taskId", direction: "outgoing" },
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
          { edge: "TaskImage.taskId", direction: "incoming" },
          { edge: "TaskImage.imageId", direction: "outgoing" },
        ],
      },
      inverse: {
        steps: [
          { edge: "TaskImage.imageId", direction: "incoming" },
          { edge: "TaskImage.taskId", direction: "outgoing" },
        ],
      },
    },
  ],
  search: { enabled: true },
  capabilities: {
    auditable: true,
    timeline: "default",
    images: {
      storage: "gallery",
      displaySources: [
        {
          relationPath: ["subject"],
          priority: 1,
          ordering: "declared",
          identityEvidence: false,
        },
        {
          relationPath: ["project"],
          priority: 2,
          ordering: "declared",
          identityEvidence: false,
        },
      ],
      ingress: [
        { kind: "self", routeId: "task-self", choice: "primary" },
        { kind: "createSelf", routeId: "task-new", enabled: true },
      ],
      routing: {
        category: "home",
        candidateFields: ["name", "description", "notes"],
        temporalFields: ["dueDate", "completedAt"],
        lifecycleFilters: [
          {
            field: "status",
            oneOf: ["not_started", "later", "in_progress", "blocked"],
          },
        ],
        signals: {
          ocrFields: ["name", "description", "notes"],
          classifierLabels: ["sticky_note"],
        },
        abstention: { minimumScore: 0.72, minimumMargin: 0.12 },
      },
    },
    countable: true,
    softDelete: true,
    delete: { mode: "soft", bulk: true },
    bulkUpdate: {
      fields: [
        "projectId",
        "projectMode",
        "status",
        "trade",
        "dueDate",
        "dueEndDate",
      ],
    },
    merge: false,
    operationOwners: { delete: "kernel", merge: null },
    mcp: ["get", "list", "search", "create", "update", "delete", "bulkUpdate"],
    dataQuality: {
      checks: [
        {
          id: "task_due_date",
          facet: "paperwork",
          weight: 1,
          label: "Due date",
          message: "No due date is recorded.",
        },
        {
          id: "task_trade",
          facet: "identity",
          weight: 1,
          label: "Trade",
          message: "No trade is recorded for this task.",
        },
      ],
    },
  },
  extensions: {
    countFilter: null,
    relatednessSignals: null,
    mcpNames: null,
    ports: {
      repository: {
        module: "~/server/repo/task/entity-adapter",
        export: "taskEntityAdapter",
      },
      references: {
        label: { module: "~/entities/entities", export: "entityLabel" },
        resolver: {
          module: "~/server/repo/shortcode-resolver",
          export: "resolveLiveShortcode",
        },
      },
      filters: {
        module: "~/entities/filter-manifest",
        export: "getEntityFilters",
      },
      search: {
        projection: {
          module: "~/server/repo/search-document",
          export: "refreshSearchDocument",
        },
        semanticText: {
          module: "~/server/repo/search-document",
          export: "getSearchDocumentEmbeddingText",
        },
        dependentRefresh: {
          module: "~/server/services/mutation-side-effects",
          export: "runMutationSideEffects",
        },
      },
    },
  },
});
