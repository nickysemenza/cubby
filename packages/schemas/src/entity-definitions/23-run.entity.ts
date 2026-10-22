import { runChildren } from "../child-tables/run.js";
import { z } from "zod";
import {
  ledgerPartyShortcode,
  runShortcode,
  vendorAccountShortcode,
  vendorShortcode,
} from "../identifier-fields.js";
import {
  RUN_PURPOSE_LABEL,
  runCause,
  runPurpose,
  runRetirementReason,
  runStatus,
  runTrigger,
} from "../run-fields.js";
import { runWorkProgress } from "../run-work-progress.js";
import { defineEntity } from "./definition.js";

const readOnly = <T extends z.ZodTypeAny>(read: T) => ({
  read,
  create: null,
  update: null,
});

/**
 * One run: a purchase-agent account sync, validation or enrichment, a
 * photo-inventory batch a member uploads for an agent to work, a Gmail
 * search or scheduled mailbox discovery, or a group of AI calls (decision suggestions on a page, an hour of MCP
 * previews, background work). The record is
 * written only by the run service and the writers; the manifest
 * exposes it read-only so the generic list, detail, inspector and MCP get/list
 * render it like any other record.
 */
export default defineEntity({
  key: "run",
  names: { singular: "Run", plural: "Runs" },
  route: { basePath: "runs" },
  table: "Run",
  children: runChildren,
  identifiers: { brand: "RunId", shortcode: "RUN-" },
  presentation: {
    titleField: "displayName",
    recordIconEntityField: "iconEntity",
    domain: "finance",
    description:
      "Runs: purchase-agent syncs, validations, enrichments, photo-inventory batches, Gmail searches and discovery, and grouped AI work.",
    emptyState: {
      title: "No runs yet",
      description:
        "Runs appear when a vendor account syncs, a purchase is validated or photos are uploaded for inventory.",
    },
    icons: {
      phosphor: "Robot",
      sfSymbol: "arrow.triangle.2.circlepath",
      emoji: "🤖",
    },
    detail: {
      activityRelations: [
        { relation: "purchases", dateField: "date" },
        { relation: "emails", dateField: "receivedAt" },
      ],
      omitRelations: {
        purchases:
          "The Changes slot's audit log lists every record the run wrote, purchases included; Purchase stores no run reference to filter by.",
      },
      hero: {
        stats: ["attempt"],
        chip: "status",
        // Import-only order counts stay in the `import-stats` slot.

        breadcrumb: "vendorAccountId",
      },
      additionalSections: [
        // A step-ledger Run (maintenance, sweep) leads with its steps; the
        // slot is empty for every other purpose.
        { kind: "slot", id: "steps", title: "Steps" },
        { kind: "slot", id: "live-progress", title: "Progress" },
        // What the run counted and the records it worked, before its
        // controls and agent: the first questions about any run.
        { kind: "slot", id: "import-stats", title: "Counts" },
        { kind: "slot", id: "import-targets", title: "Targets and outcome" },
        // Import runs (mail import, photo inventory, file import) declare
        // their workflow as slots that each gate their own visibility. A live
        // run leads with progress and its agent; a stopped run carries the
        // same two after its evidence.
        { kind: "slot", id: "import-controls", title: "Controls" },
        { kind: "slot", id: "import-progress-live", title: "Run progress" },
        { kind: "slot", id: "import-agent-live", title: "Live agent" },
        {
          kind: "slot",
          id: "import-purchases",
          workspace: "work",
          title: "Purchases changed",
        },
        {
          kind: "slot",
          id: "import-findings",
          workspace: "work",
          title: "Findings",
        },
        {
          kind: "slot",
          id: "import-prepared-orders",
          workspace: "work",
          title: "Prepared orders",
        },
        {
          kind: "slot",
          id: "import-progress-stopped",
          workspace: "evidence",
          title: "Run progress",
        },
        {
          kind: "slot",
          id: "import-agent-stopped",
          workspace: "evidence",
          title: "Agent history",
        },
        {
          kind: "slot",
          id: "import-timeline",
          workspace: "evidence",
          title: "Durable transcript",
        },
        {
          kind: "slot",
          id: "import-debug-log",
          workspace: "evidence",
          title: "System and agent log",
        },
        {
          kind: "slot",
          id: "suggestions",
          workspace: "work",
          title: "Suggestions",
        },
        {
          kind: "slot",
          id: "photo-batch",
          workspace: "work",
          title: "Photos",
          placement: "full",
        },
        {
          kind: "slot",
          id: "ai-usage",
          workspace: "evidence",
          title: "AI usage",
        },
        {
          kind: "slot",
          id: "changes",
          workspace: "evidence",
          title: "Changes",
        },
        {
          kind: "fields",
          id: "runtime",
          workspace: "evidence",
          title: "Runtime",
          fields: [
            "coordinatorModel",
            "skillRevision",
            "runtimeRevision",
            "decisionRevision",
            "predecessorRunId",
            "parentRunId",
            "cause",
            "attempt",
          ],
        },
      ],
    },
    list: {
      // Display images borrow from the vendor; they load as list media.
      read: {
        derived: ["workProgress", "activityAt"],
        media: ["displayImages"],
        quality: ["dataQuality"],
      },
      tree: { toggle: true, defaultNested: false },
      savedViews: [
        {
          id: "imports",
          label: "Imports",
          description:
            "Account syncs, mail imports, validations, enrichments, photo batches, Gmail searches and mailbox discovery",
          filters: [
            {
              id: "purpose",
              value: [
                "account_sync",
                "mail_import",
                "purchase_validation",
                "product_enrichment",
                "photo_inventory",
                "mail_search",
                "mail_discovery",
              ],
            },
          ],
        },
        {
          id: "attention",
          label: "Needs attention",
          description: "Paused Runs, Runs needing review, and failed Runs",
          filters: [
            {
              id: "status",
              value: [
                "paused",
                "paused_auth",
                "needs_review",
                "failed",
                "dispatch_failed",
              ],
            },
          ],
        },
        {
          id: "ai-work",
          label: "AI work",
          description:
            "Decision-model suggestion passes, hourly AI groups and background AI work",
          filters: [{ id: "purpose", value: ["ai_suggest", "background"] }],
        },
      ],
      // Ephemeral runs only group AI usage (thousands a day), and a routine
      // run is a scheduled pass that found nothing; a person opens the list
      // for work somebody started or that changed something. Clearing the
      // filter shows both.
      initialFilter: [
        {
          id: "trigger",
          value: ["foreground", "discovery", "manual", "backfill", "scheduled"],
        },
        { id: "routine", value: "false" },
      ],
    },
  },
  model: {
    hierarchy: { parentField: "parentRunId", maxDepth: 100 },
    fields: [
      {
        key: "workProgress",
        provenance: {
          kind: "derived",
          sources: [{ label: "Recorded work samples and step counters" }],
        },
        kind: "json",
        labelOverride: "Work",
        display: {
          detail: false,
          labelPath: "workProgress.current.label",
          renderer: { list: "run-throughput" },
        },
        validation: readOnly(runWorkProgress.nullable().default(null)),
      },
      {
        key: "activityAt",
        provenance: {
          kind: "derived",
          sources: [{ label: "Latest progress, step update, or heartbeat" }],
        },
        kind: "timestamp",
        labelOverride: "Activity",
        display: {
          detail: false,
          labelPath: "activityAt",
          renderer: { list: "run-activity" },
        },
        validation: readOnly(z.iso.datetime().nullable().default(null)),
      },
      {
        display: { detail: false, list: false },
        key: "iconEntity",
        kind: "text",
        validation: readOnly(z.string()),
      },
      {
        display: { detail: false, list: false },
        key: "displayName",
        kind: "text",
        validation: readOnly(z.string().min(1)),
      },
      {
        key: "status",
        kind: "enum",
        control: {
          kind: "select",
          options: [
            {
              value: "running",
              label: "Running",
              color: "info",
            },
            {
              value: "paused",
              label: "Paused",
              color: "warning",
            },
            {
              value: "paused_auth",
              label: "Agent authorization needed",
              color: "warning",
            },
            {
              value: "paused_offline",
              label: "Paused offline (historical)",
              color: "warning",
            },
            {
              value: "needs_review",
              label: "Needs review",
              color: "warning",
            },
            {
              value: "completed",
              label: "Completed",
              color: "positive",
            },
            {
              value: "failed",
              label: "Failed",
              color: "destructive",
            },
            {
              value: "dispatch_failed",
              label: "Dispatch failed",
              color: "destructive",
            },
          ],
        },
        display: {
          width: "sm",
          optionRole: "status",
          optionColor: "neutral-status",
        },
        validation: readOnly(runStatus),
      },
      {
        key: "purpose",
        kind: "enum",
        control: {
          kind: "select",
          options: runPurpose.options.map((value) => ({
            value,
            label: RUN_PURPOSE_LABEL[value],
          })),
        },
        display: {
          width: "sm",
          optionRole: "category",
          optionColor: "domain-finance",
          optionGlyph: { phosphor: "Gear", sfSymbol: "gearshape" },
        },
        validation: readOnly(runPurpose),
      },
      {
        key: "trigger",
        kind: "enum",
        control: {
          kind: "select",
          options: [
            {
              value: "foreground",
              label: "Foreground",
            },
            {
              value: "discovery",
              label: "Discovery",
            },
            {
              value: "manual",
              label: "Manual",
            },
            {
              value: "backfill",
              label: "Backfill",
            },
            {
              value: "scheduled",
              label: "Scheduled",
            },
            {
              value: "ephemeral",
              label: "Ephemeral",
            },
          ],
        },
        display: {
          optionRole: "category",
          optionColor: "domain-finance",
          optionGlyph: { phosphor: "Lightning", sfSymbol: "bolt" },
        },
        validation: readOnly(runTrigger),
      },
      {
        // Written when a scheduled run finishes: it completed and its purpose's
        // own count of useful work is zero (`mail_discovery`: no message saved
        // and no history event recorded). Stored, not computed, so list
        // filtering, pagination and counts run on the column everywhere.
        key: "routine",
        kind: "boolean",
        display: { list: false },
        validation: readOnly(z.boolean()),
      },
      {
        key: "vendorAccountId",
        kind: "identifier",
        nullable: true,
        reference: { entity: "vendorAccount" },
        display: { columnLabel: "Account", labelPath: "vendorAccountLabel" },
        validation: readOnly(vendorAccountShortcode.nullable()),
      },
      {
        key: "vendorId",
        kind: "identifier",
        nullable: true,
        reference: { entity: "vendor" },
        display: {},
        validation: readOnly(vendorShortcode.nullable()),
      },
      {
        key: "ledgerPartyId",
        kind: "identifier",
        // Null only on runs that group AI work (see `ensureRun`); import
        // purposes always carry the member scope (`Run_import_party_check`).
        nullable: true,
        reference: { entity: "ledgerParty" },
        display: {},
        validation: readOnly(ledgerPartyShortcode.nullable()),
      },
      {
        key: "actorName",
        kind: "text",
        display: { list: false },
        validation: readOnly(z.string()),
      },
      {
        key: "startedAt",
        kind: "timestamp",
        display: { format: "timestamp" },
        validation: readOnly(z.date()),
      },
      {
        key: "endedAt",
        kind: "timestamp",
        nullable: true,
        display: { format: "timestamp" },
        validation: readOnly(z.date().nullable()),
      },
      {
        key: "retiredAt",
        kind: "timestamp",
        nullable: true,
        display: { list: false, format: "timestamp" },
        validation: readOnly(z.date().nullable()),
      },
      {
        key: "retirementReason",
        kind: "enum",
        nullable: true,
        control: {
          kind: "select",
          options: [
            {
              value: "unrelated_source",
              label: "Unrelated source removed",
            },
            {
              value: "settled",
              label: "Settled; transcript destroyed",
            },
          ],
        },
        display: {
          list: false,
          optionRole: "category",
          optionColor: "domain-finance",
          optionGlyph: { phosphor: "Archive", sfSymbol: "archivebox" },
        },
        validation: readOnly(runRetirementReason.nullable()),
      },
      {
        key: "wallTime",
        kind: "text",
        display: { list: false },
        provenance: {
          kind: "derived",
          sources: [{ label: "Run start and end times" }],
        },
        explanation: {
          ruleId: "import-run.wall-time",
          description:
            "Elapsed time from the run's start to its end. An active run is shown as in progress.",
          readPath: "wallTime",
          sourceDependencies: [
            { path: "startedAt", label: "Started at" },
            { path: "endedAt", label: "Ended at" },
          ],
        },
        validation: readOnly(z.string()),
      },
      {
        key: "ordersSeen",
        kind: "number",
        display: { detail: false, width: "sm" },
        validation: readOnly(z.number().int().nonnegative()),
      },
      {
        key: "imported",
        kind: "number",
        display: { detail: false, width: "sm" },
        validation: readOnly(z.number().int().nonnegative()),
      },
      {
        key: "updated",
        kind: "number",
        display: { detail: false, width: "sm" },
        validation: readOnly(z.number().int().nonnegative()),
      },
      {
        key: "skipped",
        kind: "number",
        display: { detail: false, width: "sm" },
        validation: readOnly(z.number().int().nonnegative()),
      },
      {
        key: "failureCode",
        kind: "text",
        nullable: true,
        display: { list: false },
        validation: readOnly(z.string().nullable()),
      },
      {
        key: "notes",
        kind: "text",
        nullable: true,
        display: { list: false },
        validation: readOnly(z.string().nullable()),
      },
      {
        key: "coordinatorModel",
        kind: "text",
        display: { list: false },
        validation: readOnly(z.string()),
      },
      {
        key: "skillRevision",
        kind: "text",
        display: { list: false },
        validation: readOnly(z.string()),
      },
      {
        key: "runtimeRevision",
        kind: "text",
        display: { list: false },
        validation: readOnly(z.string()),
      },
      {
        key: "decisionRevision",
        kind: "number",
        display: { list: false },
        validation: readOnly(z.number().int()),
      },
      {
        key: "dispatchError",
        labelOverride: "Failure details",
        kind: "text",
        nullable: true,
        display: { list: false, renderer: { detail: "run-failure-details" } },
        validation: readOnly(z.string().nullable()),
      },
      {
        key: "coordinatorStartedAt",
        kind: "timestamp",
        nullable: true,
        display: { list: false, format: "timestamp" },
        validation: readOnly(z.date().nullable()),
      },
      {
        key: "auditedAt",
        kind: "timestamp",
        nullable: true,
        display: { list: false, format: "timestamp" },
        validation: readOnly(z.date().nullable()),
      },
      {
        key: "predecessorRunId",
        kind: "identifier",
        nullable: true,
        reference: { entity: "run" },
        display: { list: false },
        validation: readOnly(runShortcode.nullable()),
      },
      {
        key: "parentRunId",
        kind: "identifier",
        nullable: true,
        reference: { entity: "run" },
        display: { list: false },
        validation: readOnly(runShortcode.nullable()),
      },
      {
        key: "cause",
        kind: "enum",
        nullable: true,
        display: {
          list: false,
          optionRole: "category",
          optionColor: "domain-finance",
          optionGlyph: { phosphor: "Lightning", sfSymbol: "bolt" },
        },
        control: {
          kind: "select",
          options: runCause.options.map((value) => ({
            value,
            label: value.replaceAll("_", " "),
          })),
        },
        validation: readOnly(runCause.nullable()),
      },
      {
        key: "attempt",
        kind: "number",
        nullable: true,
        display: { list: false },
        validation: readOnly(z.number().int().positive().nullable()),
      },
      {
        display: {},
        key: "vendorAccountLabel",
        kind: "text",
        nullable: true,
        validation: readOnly(z.string().nullable()),
      },
      {
        display: { detail: false, list: false },
        key: "vendorName",
        kind: "text",
        nullable: true,
        validation: readOnly(z.string().nullable()),
      },
      {
        display: { detail: false, list: false },
        key: "ledgerPartyName",
        kind: "text",
        // Null with `ledgerPartyId` on runs that group AI work.
        nullable: true,
        validation: readOnly(z.string().nullable()),
      },
      {
        display: { detail: false, list: false },
        key: "id",
        kind: "identifier",
        validation: readOnly(runShortcode),
      },
      {
        key: "createdAt",
        kind: "timestamp",
        display: { list: false },
        validation: readOnly(z.date()),
      },
      {
        key: "updatedAt",
        kind: "timestamp",
        display: { list: false },
        validation: readOnly(z.date()),
      },
      { key: "shortcode", kind: "text" },
      {
        key: "deletedAt",
        kind: "timestamp",
        nullable: true,
      },
    ],
    // The actor snapshot, dispatch fencing and history walk columns stay
    // hand-written on the table: they reference the auth user table, the run
    // itself, or are operational state no surface presents.
    storage: [
      {
        key: "id",
        specialized: "primary-key:RunId",
      },
      { key: "shortcode", specialized: "shortcode" },
      { key: "ledgerPartyId", reference: "ledgerParty" },
      "actorName",
      { key: "vendorAccountId", reference: "vendorAccount" },
      { key: "vendorId", reference: "vendor" },
      {
        key: "purpose",
        defaultValue: "account_sync",
        specialized: "enum:purpose",
      },
      { key: "trigger", specialized: "enum:trigger" },
      { key: "cause", specialized: "enum:cause" },
      "attempt",
      { key: "parentRunId", reference: "run" },
      {
        key: "status",
        defaultValue: "running",
        specialized: "enum:status",
      },
      {
        key: "coordinatorModel",
        defaultValue: "gpt-6-sol",
      },
      {
        key: "skillRevision",
        defaultValue: "purchase-import@1",
      },
      {
        key: "runtimeRevision",
        defaultValue: "pi-durable@1",
      },
      { key: "decisionRevision", defaultValue: 1 },
      { key: "startedAt", defaultOverride: "now" },
      "endedAt",
      "retiredAt",
      "retirementReason",
      { key: "ordersSeen", defaultValue: 0 },
      { key: "imported", defaultValue: 0 },
      { key: "updated", defaultValue: 0 },
      { key: "skipped", defaultValue: 0 },
      { key: "routine", defaultValue: false },
      "auditedAt",
      "failureCode",
      "notes",
      "dispatchError",
      "coordinatorStartedAt",
      { key: "createdAt" },
      { key: "updatedAt", specialized: "updated-at" },
      "deletedAt",
    ],
    create: [],
    update: [],
    output: [
      "workProgress",
      "activityAt",
      "id",
      "iconEntity",
      "displayName",
      "status",
      "purpose",
      "trigger",
      "routine",
      "vendorAccountId",
      "vendorId",
      "ledgerPartyId",
      "actorName",
      "startedAt",
      "endedAt",
      "retiredAt",
      "retirementReason",
      "wallTime",
      "ordersSeen",
      "imported",
      "updated",
      "skipped",
      "failureCode",
      "notes",
      "coordinatorModel",
      "skillRevision",
      "runtimeRevision",
      "decisionRevision",
      "dispatchError",
      "coordinatorStartedAt",
      "auditedAt",
      "predecessorRunId",
      "parentRunId",
      "cause",
      "attempt",
      "vendorAccountLabel",
      "vendorName",
      "ledgerPartyName",
      "createdAt",
      "updatedAt",
    ],
    audit: [],
    sort: {
      fields: [
        "startedAt",
        "endedAt",
        "status",
        "purpose",
        "ordersSeen",
        "imported",
      ],
    },
  },
  fields: {
    create: null,
    update: null,
    output: {
      module: "@cubby/schemas/run",
      export: "runOut",
    },
  },
  // One durable attempt to discover, fetch, extract, write, and audit evidence.
  storage: {
    // The actor snapshot, the run's own lineage, dispatch fencing and the
    // history walk are operational state outside the model.
    columns: [
      {
        key: "actorUserId",
        kind: "text",
        notNull: true,
        type: { module: "@cubby/schemas/identifiers", export: "UserId" },
        reference: "user",
      },
      { key: "actorEmail", kind: "text", notNull: true },
      // Null when the actor has no member party (the system user).
      { key: "actorLedgerPartyShortcode", kind: "text" },
      { key: "actorLedgerPartyName", kind: "text" },
      { key: "actorLedgerPartyKind", kind: "text" },
      {
        key: "predecessorRunId",
        kind: "identifier",
        type: { module: "@cubby/schemas/identifiers", export: "RunId" },
        reference: "run",
      },
      // Stable queue generation; duplicate and late deliveries are fenced to it.
      { key: "dispatchEventId", kind: "text" },
      { key: "agentSessionId", kind: "text" },
      // The order-history page the walk resumes from; null before the first
      // listing.
      { key: "historyCursorUrl", kind: "text" },
      // Set when a listing had no next page or predated the account cursor.
      { key: "historyExhaustedAt", kind: "timestamp" },
      // Caller attribution for the work the run groups (see `ActorContext`).
      {
        key: "channel",
        kind: "text",
        notNull: true,
        type: { module: "@cubby/schemas/context", export: "AuditChannel" },
        defaultValue: "web",
      },
      // Deliberately not FKs, like `McpToolCall.clientId`: a run keeps naming
      // the client and install that started it after either is removed.
      { key: "oauthClientId", kind: "text" },
      {
        key: "deviceId",
        kind: "identifier",
        type: { module: "@cubby/schemas/identifiers", export: "DeviceId" },
      },
      // Client-minted grouping key, e.g. one decision pass per page mount.
      { key: "clientKey", kind: "text" },
      // What the run was asked to do; the shape belongs to its purpose.
      {
        key: "input",
        kind: "json",
        type: { module: "@cubby/schemas/run-fields", export: "RunInput" },
      },
      {
        key: "liveProgress",
        kind: "json",
        type: {
          module: "@cubby/schemas/run-fields",
          export: "RunLiveProgressEvent",
        },
      },
      {
        key: "progressHistory",
        kind: "json",
        type: {
          module: "@cubby/schemas/run-fields",
          export: "RunProgressHistory",
        },
      },
      // Display history is bounded; replay identity is retained for the Run's lifetime.
      {
        key: "progressEventIds",
        kind: "json",
        type: {
          module: "@cubby/schemas/run-fields",
          export: "RunProgressEventIds",
        },
      },
      { key: "heartbeatAt", kind: "timestamp" },
      // Resumable position within `input`; the shape belongs to its purpose.
      {
        key: "progress",
        kind: "json",
        type: { module: "@cubby/schemas/run-fields", export: "RunProgress" },
      },
    ],
    indexes: [
      {
        // Current execution and repair reads must not scan retained Run payloads.
        name: "Run_live_status_failure_purpose_idx",
        on: ["status", "failureCode", "purpose"],
        where: "{deletedAt} IS NULL",
      },
      {
        name: "Run_party_started_idx",
        on: ["ledgerPartyId", { column: "startedAt", desc: true }],
      },
      { name: "Run_parent_started_idx", on: ["parentRunId", "startedAt"] },
      {
        name: "Run_vendorAccount_started_idx",
        on: ["vendorAccountId", { column: "startedAt", desc: true }],
      },
      {
        name: "Run_clientKey_unique",
        on: ["clientKey"],
        unique: true,
        where: "{clientKey} IS NOT NULL",
      },
      {
        name: "Run_dispatch_event_unique",
        on: ["dispatchEventId"],
        unique: true,
        where: "{dispatchEventId} IS NOT NULL",
      },
      {
        name: "Run_one_active_vendor_account_key",
        on: ["vendorAccountId"],
        unique: true,
        where:
          "{vendorAccountId} IS NOT NULL AND {status} IN ('running', 'paused', 'paused_auth', 'paused_offline')",
      },
      {
        // One scheduled pass per mailbox at a time: an overlapping cron and
        // app-open trigger lose the insert instead of both walking the cursor.
        name: "Run_one_active_mail_discovery",
        on: ["ledgerPartyId", { sql: "COALESCE({input}->>'mailboxId', '')" }],
        unique: true,
        where: "{purpose} = 'mail_discovery' AND {status} = 'running'",
      },
      {
        // One maintenance pass at a time: a cron and a "Run now" racing each
        // other lose the insert and return the active pass instead.
        name: "Run_one_active_maintenance",
        on: ["purpose"],
        unique: true,
        where:
          "{purpose} = 'maintenance' AND {status} IN ('running', 'paused_auth')",
      },
      {
        name: "Run_one_active_derived_refresh",
        on: ["purpose"],
        unique: true,
        where:
          "{purpose} = 'derived_refresh' AND {status} IN ('running', 'paused_auth', 'paused')",
      },
    ],
    checks: [
      { column: "trigger" },
      {
        name: "Run_import_party_check",
        sql: "{purpose} NOT IN ('account_sync', 'mail_import', 'purchase_validation', 'product_enrichment', 'photo_inventory', 'mail_discovery') OR ({ledgerPartyId} IS NOT NULL AND {actorLedgerPartyShortcode} IS NOT NULL)",
      },
      {
        column: "channel",
        values: ["web", "api", "mcp", "caldav", "system"],
      },
      { column: "status" },
      { column: "purpose" },
      { column: "cause" },
      {
        name: "Run_attempt_positive",
        sql: "{attempt} IS NULL OR {attempt} > 0",
      },
      {
        name: "Run_photo_inventory_no_vendor_check",
        sql: "{purpose} <> 'photo_inventory' OR {vendorAccountId} IS NULL",
      },
    ],
    unindexedReferences: {
      vendorId: "runs are listed by vendor account, never by vendor alone",
      predecessorRunId: "lineage is walked forward from a known run only",
      actorUserId: "runs are listed by ledger party; the user is a snapshot",
    },
  },
  filters: {
    schema: {
      module: "@cubby/schemas/run",
      export: "runFilterFields",
    },
    descriptors: [
      {
        columnId: "status",
        kind: "multiselect",
        placeholder: "Filter by status...",
        deriveSchema: true,
        stored: true,
        schemaFromRead: true,
        options: [
          { value: "running", label: "Running", color: "var(--info)" },
          { value: "paused", label: "Paused", color: "var(--warning)" },
          {
            value: "paused_auth",
            label: "Agent authorization needed",
            color: "var(--warning)",
          },
          {
            value: "paused_offline",
            label: "Paused offline (historical)",
            color: "var(--warning)",
          },
          {
            value: "needs_review",
            label: "Needs review",
            color: "var(--warning)",
          },
          { value: "completed", label: "Completed", color: "var(--positive)" },
          { value: "failed", label: "Failed", color: "var(--destructive)" },
          {
            value: "dispatch_failed",
            label: "Dispatch failed",
            color: "var(--destructive)",
          },
        ],
      },
      {
        columnId: "purpose",
        kind: "multiselect",
        placeholder: "Filter by purpose...",
        deriveSchema: true,
        stored: true,
        schemaFromRead: true,
      },
      {
        columnId: "trigger",
        kind: "multiselect",
        placeholder: "Filter by trigger...",
        deriveSchema: true,
        stored: true,
        schemaFromRead: true,
      },
      {
        columnId: "routine",
        field: "routine",
        kind: "boolean",
        placeholder: "Filter routine runs...",
        deriveSchema: true,
        stored: true,
        schemaDescription:
          "Filter scheduled runs that completed without finding anything",
        options: [
          { value: "true", label: "Routine" },
          { value: "false", label: "Not routine" },
        ],
      },
      {
        columnId: "vendorAccountId",
        kind: "idMulti",
        placeholder: "Filter by vendor account...",
        brandRef: { entity: "vendorAccount" },
        deriveSchema: true,
        stored: true,
      },
      {
        columnId: "vendorId",
        kind: "idMulti",
        placeholder: "Filter by vendor...",
        brandRef: { entity: "vendor" },
        deriveSchema: true,
        stored: true,
      },
      {
        columnId: "ledgerPartyId",
        kind: "idMulti",
        placeholder: "Filter by member...",
        brandRef: { entity: "ledgerParty" },
        currentMember: true,
        deriveSchema: true,
        stored: true,
      },
      {
        columnId: "parentRunId",
        kind: "idMulti",
        placeholder: "Filter by parent Run...",
        brandRef: { entity: "run" },
        deriveSchema: true,
        stored: true,
      },
    ],
  },
  relations: [
    {
      key: "vendor-account",
      label: "Vendor account",
      target: "vendorAccount",
      cardinality: "one",
      provenance: {
        kind: "local-path",
        steps: [{ edge: "Run.vendorAccountId", direction: "outgoing" }],
      },
      inverse: {
        steps: [{ edge: "Run.vendorAccountId", direction: "incoming" }],
      },
    },
    {
      key: "vendor",
      label: "Vendor",
      target: "vendor",
      cardinality: "one",
      provenance: {
        kind: "local-path",
        steps: [{ edge: "Run.vendorId", direction: "outgoing" }],
      },
      inverse: {
        steps: [{ edge: "Run.vendorId", direction: "incoming" }],
      },
    },
    {
      key: "ledger-party",
      label: "Member",
      target: "ledgerParty",
      cardinality: "one",
      provenance: {
        kind: "local-path",
        steps: [{ edge: "Run.ledgerPartyId", direction: "outgoing" }],
      },
      inverse: {
        steps: [{ edge: "Run.ledgerPartyId", direction: "incoming" }],
      },
    },
    {
      key: "predecessor",
      label: "Predecessor",
      target: "run",
      cardinality: "one",
      inverseOmit:
        "A run links its predecessor; a retry chain is short and read from the newest run back.",
      provenance: {
        kind: "local-path",
        steps: [{ edge: "Run.predecessorRunId", direction: "outgoing" }],
      },
      inverse: {
        steps: [{ edge: "Run.predecessorRunId", direction: "incoming" }],
      },
    },
    {
      key: "parent",
      label: "Parent Run",
      target: "run",
      cardinality: "one",
      provenance: {
        kind: "local-path",
        steps: [{ edge: "Run.parentRunId", direction: "outgoing" }],
      },
      inverse: {
        steps: [{ edge: "Run.parentRunId", direction: "incoming" }],
      },
    },
    {
      key: "children",
      label: "Child Runs",
      target: "run",
      cardinality: "many",
      provenance: {
        kind: "local-path",
        steps: [{ edge: "Run.parentRunId", direction: "incoming" }],
      },
      inverse: {
        steps: [{ edge: "Run.parentRunId", direction: "outgoing" }],
      },
    },
    {
      key: "purchases",
      label: "Purchases",
      target: "purchase",
      cardinality: "many",
      provenance: {
        kind: "local-path",
        steps: [{ edge: "Purchase.runId", direction: "incoming" }],
      },
      inverse: {
        steps: [{ edge: "Purchase.runId", direction: "outgoing" }],
      },
    },
  ],
  search: false,
  capabilities: {
    auditable: false,
    images: {
      storage: false,
    },
    softDelete: false,
    delete: null,
    merge: false,
    // The run service and import writers own every write.
    lifecycle: "readOnly",
    dataQuality: {
      checks: [
        {
          id: "run_attribution",
          satisfiedLabel: "Actor attributed",
          placement: { field: "actorName" },
          facet: "provenance",
          kind: "defect",
          weight: 1,
          scoreCap: 49,
          label: "Actor attribution",
          message: "The run has no recorded actor name.",
        },
        {
          id: "run_timeline",
          satisfiedLabel: "Timeline recorded",
          placement: { section: "import-timeline" },
          facet: "integrity",
          kind: "defect",
          weight: 1,
          scoreCap: 49,
          label: "Run timeline",
          message:
            "The run ends before it starts or its terminal status has no end time.",
        },
        {
          id: "run_target_outcomes",
          satisfiedLabel: "Target outcomes recorded",
          placement: { section: "import-targets" },
          facet: "integrity",
          kind: "defect",
          weight: 3,
          scoreCap: 49,
          label: "Target outcomes",
          message:
            "A completed targeted run has no targets or has an unfinished or unexplained target outcome.",
        },
      ],
    },
  },
  extensions: {
    ports: {
      repository: {
        module: "~/server/domains/run/repo/run",
        export: "runRepository",
      },
    },
  },
});
