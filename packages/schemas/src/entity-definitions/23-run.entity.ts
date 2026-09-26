import { z } from "zod";

import {
  ledgerPartyShortcode,
  runShortcode,
  vendorAccountShortcode,
  vendorShortcode,
} from "../identifier-fields.js";
import { runPurpose, runStatus, runTrigger } from "../run-fields.js";
import { defineEntity } from "./definition.js";

const readOnly = <T extends z.ZodTypeAny>(read: T) => ({
  read,
  create: null,
  update: null,
});

/**
 * One run: a purchase-agent account sync, validation or enrichment, a
 * photo-inventory batch a member uploads for an agent to work, or a group of
 * AI calls (Jev suggestions on a page, one AI action, background work). The record is
 * written only by the run service and the writers; the manifest
 * exposes it read-only so the generic list, detail, inspector and MCP get/list
 * render it like any other record.
 */
export default defineEntity({
  key: "run",
  names: { singular: "Run", plural: "Runs" },
  route: {
    basePath: "runs",
    // No create/update contract, so outside the kernel detail roster: the
    // generic page reads the run through its own query.
    detailOverride: {
      query: {
        module: "~/entities/run.functions",
        export: "runDetailQuery",
      },
    },
  },
  table: "Run",
  identifiers: { brand: "RunId", shortcode: "RUN-" },
  presentation: {
    titleField: "displayName",
    domain: "finance",
    description:
      "Runs: purchase-agent syncs, validations, enrichments, photo-inventory batches and grouped AI work.",
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
      omitRelations: {
        purchases:
          "The Changes slot's audit log lists every record the run wrote, purchases included; Purchase stores no run reference to filter by.",
      },
      hero: {
        chip: "status",
        // Order counts belong to import runs only; the `import-workflow`
        // slot renders them, so AI runs don't show four zeros.
        stats: [],
        breadcrumb: "vendorAccountId",
      },
      additionalSectionOverrides: [
        { kind: "slot", id: "import-workflow", title: "Import" },
        { kind: "slot", id: "photo-batch", title: "Photos", placement: "full" },
        { kind: "slot", id: "ai-usage", title: "AI usage" },
        { kind: "slot", id: "changes", title: "Changes" },
        {
          kind: "fields",
          id: "runtime",
          title: "Runtime",
          placement: "supporting",
          collapsed: true,
          fields: [
            "coordinatorModel",
            "skillRevision",
            "runtimeRevision",
            "decisionRevision",
            "dispatchAttempts",
            "predecessorRunId",
          ],
        },
      ],
    },
    list: {},
  },
  model: {
    fields: [
      {
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
            { value: "running", label: "Running" },
            { value: "paused_auth", label: "Sign-in needed" },
            { value: "paused_offline", label: "Mac offline" },
            { value: "paused_approval", label: "Awaiting approval" },
            { value: "needs_review", label: "Needs review" },
            { value: "completed", label: "Completed" },
            { value: "failed", label: "Failed" },
            { value: "dispatch_failed", label: "Dispatch failed" },
          ],
        },
        display: { list: true, detail: true, width: "sm" },
        validation: readOnly(runStatus),
      },
      {
        key: "purpose",
        kind: "enum",
        control: {
          kind: "select",
          options: [
            { value: "account_sync", label: "Account sync" },
            { value: "purchase_validation", label: "Purchase validation" },
            { value: "product_enrichment", label: "Product enrichment" },
            { value: "photo_inventory", label: "Photo inventory" },
            { value: "ai_suggest", label: "AI suggestions" },
            { value: "ai_action", label: "AI action" },
            { value: "background", label: "Background" },
            { value: "file_import", label: "File import" },
            { value: "legacy", label: "Legacy" },
          ],
        },
        display: { list: true, detail: true, width: "sm" },
        validation: readOnly(runPurpose),
      },
      {
        key: "trigger",
        kind: "enum",
        control: {
          kind: "select",
          options: [
            { value: "foreground", label: "Foreground" },
            { value: "discovery", label: "Discovery" },
            { value: "manual", label: "Manual" },
            { value: "backfill", label: "Backfill" },
            { value: "ephemeral", label: "Ephemeral" },
          ],
        },
        display: { list: true, detail: true, width: "sm" },
        validation: readOnly(runTrigger),
      },
      {
        key: "vendorAccountId",
        kind: "identifier",
        nullable: true,
        reference: { entity: "vendorAccount" },
        display: {
          list: true,
          detail: true,
        },
        validation: readOnly(vendorAccountShortcode.nullable()),
      },
      {
        key: "vendorId",
        kind: "identifier",
        nullable: true,
        reference: { entity: "vendor" },
        display: { list: true, detail: true },
        validation: readOnly(vendorShortcode.nullable()),
      },
      {
        key: "ledgerPartyId",
        kind: "identifier",
        // Null only on runs that group AI work (see `ensureRun`); import
        // purposes always carry the member scope (`Run_import_party_check`).
        nullable: true,
        reference: { entity: "ledgerParty" },
        display: {
          list: true,
          detail: true,
        },
        validation: readOnly(ledgerPartyShortcode.nullable()),
      },
      {
        key: "actorName",
        kind: "text",
        display: { detail: true },
        validation: readOnly(z.string()),
      },
      {
        key: "startedAt",
        kind: "timestamp",
        display: { list: true, detail: true, format: "timestamp" },
        validation: readOnly(z.date()),
      },
      {
        key: "endedAt",
        kind: "timestamp",
        nullable: true,
        display: { list: true, detail: true, format: "timestamp" },
        validation: readOnly(z.date().nullable()),
      },
      {
        key: "wallTime",
        kind: "text",
        display: { detail: true },
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
        display: { list: true, width: "sm" },
        validation: readOnly(z.number().int().nonnegative()),
      },
      {
        key: "imported",
        kind: "number",
        display: { list: true, width: "sm" },
        validation: readOnly(z.number().int().nonnegative()),
      },
      {
        key: "updated",
        kind: "number",
        display: { list: true, width: "sm" },
        validation: readOnly(z.number().int().nonnegative()),
      },
      {
        key: "skipped",
        kind: "number",
        display: { list: true, width: "sm" },
        validation: readOnly(z.number().int().nonnegative()),
      },
      {
        key: "failureCode",
        kind: "text",
        nullable: true,
        display: { detail: true },
        validation: readOnly(z.string().nullable()),
      },
      {
        key: "notes",
        kind: "text",
        nullable: true,
        display: { detail: true },
        validation: readOnly(z.string().nullable()),
      },
      {
        key: "coordinatorModel",
        kind: "text",
        display: { detail: true },
        validation: readOnly(z.string()),
      },
      {
        key: "skillRevision",
        kind: "text",
        display: { detail: true },
        validation: readOnly(z.string()),
      },
      {
        key: "runtimeRevision",
        kind: "text",
        display: { detail: true },
        validation: readOnly(z.string()),
      },
      {
        key: "decisionRevision",
        kind: "number",
        display: { detail: true },
        validation: readOnly(z.number().int()),
      },
      {
        key: "dispatchAttempts",
        kind: "number",
        display: { detail: true },
        validation: readOnly(z.number().int().nonnegative()),
      },
      {
        key: "dispatchError",
        kind: "text",
        nullable: true,
        display: { detail: true },
        validation: readOnly(z.string().nullable()),
      },
      {
        key: "coordinatorStartedAt",
        kind: "timestamp",
        nullable: true,
        display: { detail: true, format: "timestamp" },
        validation: readOnly(z.date().nullable()),
      },
      {
        key: "auditedAt",
        kind: "timestamp",
        nullable: true,
        display: { detail: true, format: "timestamp" },
        validation: readOnly(z.date().nullable()),
      },
      {
        key: "predecessorRunId",
        kind: "identifier",
        nullable: true,
        reference: { entity: "run" },
        display: { detail: true },
        validation: readOnly(runShortcode.nullable()),
      },
      {
        key: "vendorAccountLabel",
        kind: "text",
        nullable: true,
        validation: readOnly(z.string().nullable()),
      },
      {
        key: "vendorName",
        kind: "text",
        nullable: true,
        validation: readOnly(z.string().nullable()),
      },
      {
        key: "ledgerPartyName",
        kind: "text",
        // Null with `ledgerPartyId` on runs that group AI work.
        nullable: true,
        validation: readOnly(z.string().nullable()),
      },
      {
        key: "id",
        kind: "identifier",
        validation: readOnly(runShortcode),
      },
      {
        key: "createdAt",
        kind: "timestamp",
        display: { detail: true },
        validation: readOnly(z.date()),
      },
      {
        key: "updatedAt",
        kind: "timestamp",
        display: { detail: true },
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
        defaultValue: "flue@1",
      },
      { key: "decisionRevision", defaultValue: 1 },
      { key: "startedAt", defaultOverride: "now" },
      "endedAt",
      { key: "ordersSeen", defaultValue: 0 },
      { key: "imported", defaultValue: 0 },
      { key: "updated", defaultValue: 0 },
      { key: "skipped", defaultValue: 0 },
      "auditedAt",
      "failureCode",
      "notes",
      { key: "dispatchAttempts", defaultValue: 0 },
      "dispatchError",
      "coordinatorStartedAt",
      { key: "createdAt" },
      { key: "updatedAt", specialized: "updated-at" },
      "deletedAt",
    ],
    create: [],
    update: [],
    output: [
      "id",
      "displayName",
      "status",
      "purpose",
      "trigger",
      "vendorAccountId",
      "vendorId",
      "ledgerPartyId",
      "actorName",
      "startedAt",
      "endedAt",
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
      "dispatchAttempts",
      "dispatchError",
      "coordinatorStartedAt",
      "auditedAt",
      "predecessorRunId",
      "vendorAccountLabel",
      "vendorName",
      "ledgerPartyName",
      "createdAt",
      "updatedAt",
    ],
    bulk: [],
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
          {
            value: "paused_auth",
            label: "Sign-in needed",
            color: "var(--warning)",
          },
          {
            value: "paused_offline",
            label: "Mac offline",
            color: "var(--warning)",
          },
          {
            value: "paused_approval",
            label: "Awaiting approval",
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
        columnId: "vendorAccountId",
        kind: "idMulti",
        placeholder: "Filter by vendor account...",
        brandRef: { entity: "vendorAccount" },
        urlOnly: true,
        deriveSchema: true,
        stored: true,
      },
      {
        columnId: "vendorId",
        kind: "idMulti",
        placeholder: "Filter by vendor...",
        brandRef: { entity: "vendor" },
        urlOnly: true,
        deriveSchema: true,
        stored: true,
      },
      {
        columnId: "ledgerPartyId",
        kind: "idMulti",
        placeholder: "Filter by member...",
        brandRef: { entity: "ledgerParty" },
        urlOnly: true,
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
  search: { enabled: false },
  capabilities: {
    auditable: false,
    images: {
      storage: false,
    },
    countable: true,
    softDelete: false,
    delete: null,
    bulkUpdate: null,
    merge: false,
    operationOwners: { delete: null, merge: null },
    mcp: ["get", "list"],
  },
  extensions: {
    ports: {
      repository: {
        module: "~/server/repo/run",
        export: "runRepository",
      },
    },
  },
});
