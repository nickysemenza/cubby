import { literalEntity } from "../literal.js";

export default literalEntity({
  key: "task",
  names: { singular: "Task", plural: "Tasks" },
  route: { basePath: "tasks" },
  table: "Task",
  identifiers: { brand: "TaskId", shortcode: "TSK-", legacy: null },
  presentation: { titleField: "name" },
  fields: {
    create: { module: "@cubby/schemas/project", export: "taskCreateInput" },
    update: { module: "@cubby/schemas/project", export: "taskUpdateData" },
    output: { module: "@cubby/schemas/project", export: "taskOut" },
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
      },
      {
        columnId: "status",
        kind: "multiselect",
        placeholder: "Filter by status...",
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
        optionsRef: {
          module: "~/app/projects/trade-options",
          export: "tradeOptions",
        },
      },
      {
        columnId: "dueDate",
        kind: "range",
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
        brandRef: { entity: "project", kind: "id" },
        nullable: { field: "projectPresenceFilter", label: "project" },
      },
      {
        columnId: "productId",
        field: "subjectProductId",
        urlKey: "productId",
        kind: "id",
        placeholder: "Filter by product id...",
        brandRef: { entity: "product", kind: "id" },
        urlOnly: true,
      },
      {
        columnId: "subjectProduct",
        field: "subjectProductId",
        kind: "idMulti",
        placeholder: "Filter by product...",
        optionsKey: "taskProducts",
        brandRef: { entity: "product", kind: "id" },
        nullable: { field: "subjectProductPresenceFilter", label: "product" },
      },
      {
        columnId: "parentTask",
        field: "parentTaskId",
        kind: "idMulti",
        placeholder: "Filter by parent task...",
        optionsKey: "parentTask",
        brandRef: { entity: "task", kind: "id" },
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
      key: "project",
      label: "Project",
      target: "project",
      provenance: {
        kind: "local-path",
        steps: [{ edge: "Task.projectId", direction: "outgoing" }],
      },
      deletionPolicy: "restrict",
      inverse: { steps: [{ edge: "Task.projectId", direction: "incoming" }] },
    },
    {
      key: "subject",
      label: "Subject product",
      target: "product",
      provenance: {
        kind: "local-path",
        steps: [{ edge: "Task.subjectProductId", direction: "outgoing" }],
      },
      deletionPolicy: "restrict",
      inverse: {
        steps: [{ edge: "Task.subjectProductId", direction: "incoming" }],
      },
    },
    {
      key: "parent",
      label: "Parent task",
      target: "task",
      provenance: {
        kind: "local-path",
        steps: [{ edge: "Task.parentTaskId", direction: "outgoing" }],
      },
      deletionPolicy: "restrict",
      inverse: {
        steps: [{ edge: "Task.parentTaskId", direction: "incoming" }],
      },
    },
    {
      key: "blocked-by",
      label: "Blocked by",
      target: "task",
      provenance: {
        kind: "local-path",
        steps: [
          { edge: "TaskDependency.taskId", direction: "incoming" },
          { edge: "TaskDependency.blockedByTaskId", direction: "outgoing" },
        ],
      },
      deletionPolicy: "restrict",
      inverse: {
        steps: [
          { edge: "TaskDependency.blockedByTaskId", direction: "incoming" },
          { edge: "TaskDependency.taskId", direction: "outgoing" },
        ],
      },
    },
  ],
  search: { enabled: true },
  capabilities: {
    auditable: true,
    images: false,
    countable: true,
    softDelete: true,
    delete: { mode: "soft", bulk: true },
    bulkUpdate: {
      fields: ["projectId", "status", "trade", "dueDate", "dueEndDate"],
    },
    merge: false,
    mcp: ["get", "list", "create", "update", "delete"],
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
      lifecycle: {
        policy: {
          module: "~/server/repo/task/crud",
          export: "TASK_DELETE_EDGE_POLICY",
        },
        runtime: {
          module: "~/server/repo/task/entity-adapter",
          export: "taskEntityAdapter",
        },
      },
      relationMutation: { attach: null, detach: null },
    },
  },
});
