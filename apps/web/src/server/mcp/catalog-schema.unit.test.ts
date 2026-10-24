import { entityGraphRootSchema } from "@cubby/schemas/entity-graph";
import { PUBLIC_SHORTCODE_PREFIXES } from "@cubby/shared";
import { Ajv } from "@modelcontextprotocol/client/validators/ajv";
import { McpServer } from "@modelcontextprotocol/server";
import { fromAny } from "@total-typescript/shoehorn";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { type JSONType, z } from "zod";

import { withErrorReporting } from "~/server/errors/report-error";
import {
  MCP_TOOL_BINDINGS,
  MCP_TOOL_DECLARATIONS,
} from "~/server/generated/mcp-tools.gen";
import { encodeAuditCursor } from "~/server/generic/audit-log/repo/audit-log";

import {
  callMcpTool,
  observedMcpRuntime,
  registerTestTool,
} from "../testing/mcp-test-utils";
import { listMcpToolCatalog } from "./server";
import { mergeActionInputSchemas } from "./tools/action-schema";
import { describeMcpActions } from "./tools/progressive-disclosure";
import {
  safeToJsonSchema,
  stripMockFromJsonSchema,
} from "./tools/tool-json-schema";
import { compiledMcpTools } from "./tools/tool-registration";

type JsonObject = Extract<JSONType, { [key: string]: JSONType }>;

interface IdField {
  path: string;
  node: JSONType;
}

function isJsonObject(value: JSONType): value is JsonObject {
  return value !== null && !Array.isArray(value) && typeof value === "object";
}

function isString(value: JSONType): value is string {
  return typeof value === "string";
}

function parseJson<T>(value: T): JSONType {
  return z.json().parse(value);
}

function parseJsonObject<T>(value: T): JsonObject {
  const parsed = parseJson(value);
  if (!isJsonObject(parsed)) throw new Error("Expected a JSON object");
  return parsed;
}

function jsonHasMock(value: JSONType): boolean {
  if (Array.isArray(value)) return value.some(jsonHasMock);
  if (!isJsonObject(value)) return false;
  return "mock" in value || Object.values(value).some(jsonHasMock);
}

function schemaHasMock<T>(value: T): boolean {
  const parsed = z.json().safeParse(value);
  return parsed.success && jsonHasMock(parsed.data);
}

function stringSchemas(
  node: JSONType,
  definitions: JsonObject,
  seen = new Set<string>(),
): JsonObject[] {
  if (Array.isArray(node))
    return node.flatMap((entry) => stringSchemas(entry, definitions, seen));
  if (!isJsonObject(node)) return [];
  if (node.$ref !== undefined && isString(node.$ref)) {
    const name = node.$ref.split("/").at(-1);
    if (!name || definitions[name] === undefined)
      throw new Error(`Dangling input schema reference: ${node.$ref}`);
    if (seen.has(name)) return [];
    return stringSchemas(
      definitions[name],
      definitions,
      new Set([...seen, name]),
    );
  }
  // zod 4.5 emits nullable strings as `type: ["string", "null"]` rather than
  // an `anyOf` branch; both spellings must stay visible to the id-field guard.
  if (
    node.type === "string" ||
    (Array.isArray(node.type) && node.type.includes("string"))
  ) {
    return [node];
  }
  if (node.type === "array" && node.items !== undefined) {
    return stringSchemas(node.items, definitions, seen);
  }
  return [node.anyOf, node.oneOf, node.allOf].flatMap((branches) =>
    branches === undefined ? [] : stringSchemas(branches, definitions, seen),
  );
}

function collectIdFields(
  schema: JSONType,
  path: string,
  out: IdField[],
  definitions: JsonObject,
  stack = new Set<string>(),
): void {
  if (!isJsonObject(schema)) return;
  if (schema.$ref !== undefined && isString(schema.$ref)) {
    const name = schema.$ref.split("/").at(-1);
    if (!name || stack.has(name) || !definitions[name]) return;
    collectIdFields(
      definitions[name],
      path,
      out,
      definitions,
      new Set([...stack, name]),
    );
    return;
  }
  if (schema.properties && isJsonObject(schema.properties)) {
    // Purchase-agent execution ids address the run ledger itself; they are
    // opaque idempotency keys, not Cubby entity references/shortcodes.
    const entityProperties = Object.entries(schema.properties).filter(
      ([key]) => key !== "_runExecution",
    );
    for (const [key, value] of entityProperties) {
      const next = path ? `${path}.${key}` : key;
      const strings = stringSchemas(value, definitions);
      if (
        (key === "id" || key === "ids" || /Ids?$/u.test(key)) &&
        strings.length > 0
      ) {
        out.push({ path: next, node: value });
      }
      collectIdFields(value, next, out, definitions, stack);
    }
  }
  if (schema.items)
    collectIdFields(schema.items, `${path}[]`, out, definitions, stack);
  for (const branches of [schema.anyOf, schema.oneOf, schema.allOf]) {
    if (Array.isArray(branches)) {
      for (const branch of branches)
        collectIdFields(branch, path, out, definitions, stack);
    }
  }
}

function schemaProperties<T>(value: T): JsonObject | undefined {
  const parsed = z.json().safeParse(value);
  if (!parsed.success || !isJsonObject(parsed.data)) return undefined;
  return parsed.data.properties && isJsonObject(parsed.data.properties)
    ? parsed.data.properties
    : undefined;
}

function concreteOutputSchema(value: JSONType): boolean {
  if (!isJsonObject(value)) return false;
  const definitions = value.$defs ?? value.definitions ?? {};
  if (!isJsonObject(definitions)) return false;
  const visit = (node: JSONType, seen = new Set<string>()): boolean => {
    if (!isJsonObject(node)) return false;
    if (node.$ref !== undefined && isString(node.$ref)) {
      const name = node.$ref.split("/").at(-1);
      if (!name || seen.has(name) || !definitions[name]) return false;
      return visit(definitions[name], new Set([...seen, name]));
    }
    if (node.properties && isJsonObject(node.properties))
      return Object.keys(node.properties).length > 0;
    if (Array.isArray(node.allOf))
      return node.allOf.some((branch) => visit(branch, seen));
    const alternatives = node.anyOf ?? node.oneOf;
    return (
      Array.isArray(alternatives) &&
      alternatives.length > 0 &&
      alternatives.every((branch) => visit(branch, seen))
    );
  };
  return visit(value);
}

let catalog: Awaited<ReturnType<typeof listMcpToolCatalog>>;
beforeAll(async () => {
  catalog = await listMcpToolCatalog();
});

describe("MCP catalog schemas", () => {
  // Physical QR labels must remain valid while the catalog advertises canonical IDs.
  it("accepts legacy graph labels without accepting another entity's label", () => {
    expect(
      entityGraphRootSchema.safeParse({
        entityKind: "product",
        entityId: "P-4K7M",
      }).success,
    ).toBe(true);
    expect(
      entityGraphRootSchema.safeParse({
        entityKind: "location",
        entityId: "L-4K7M",
      }).success,
    ).toBe(true);
    expect(
      entityGraphRootSchema.safeParse({
        entityKind: "location",
        entityId: "P-4K7M",
      }).success,
    ).toBe(false);
  });
  it("accepts returned audit cursors, research notes and attachments in the published catalog", async () => {
    const tools = catalog.tools;
    const validator = new Ajv({ strict: false, validateFormats: true });
    const accepts = (name: string, input: JsonObject) => {
      const tool = tools.find((tool) => tool.name === name);
      if (!tool) throw new Error(`Missing tool ${name}`);
      const validate = validator.compile(tool.inputSchema);
      expect(validate(input)).toBe(true);
    };
    accepts("activity_read", {
      action: "list",
      input: {
        cursor: encodeAuditCursor({
          createdAt: new Date("2026-07-20T12:00:00Z"),
          id: "00000000-0000-4000-8000-000000000001",
        }),
      },
    });
    accepts("entity", {
      action: "update",
      entity: "product",
      id: "PRD-4K7M",
      data: {
        brandId: "VEN-4K7M",
        notes:
          "EXP-4K7M: Original order line; observed 2026-07-20; Blue, single",
      },
    });
    accepts("image", {
      action: "attach_file",
      input: {
        items: [{ entityId: "PRD-4K7M", url: "https://example.com/item.jpg" }],
      },
    });
  });

  it("keeps repeated constrained workflow fields compact without weakening accepted inputs", () => {
    const field = {
      type: "string",
      minLength: 3,
      maxLength: 40,
      description:
        "Stable evidence key shared by each input field in the workflow.",
    };
    const schema = mergeActionInputSchemas([
      {
        name: "inspect",
        description: "Inspect evidence",
        schema: {
          type: "object",
          properties: {
            first: field,
            second: field,
            third: field,
            fourth: field,
          },
        },
      },
    ]);
    const validate = new Ajv({ strict: false, validateFormats: false }).compile(
      schema,
    );
    expect(
      validate({
        action: "inspect",
        first: "valid",
        second: "valid",
        third: "valid",
        fourth: "valid",
      }),
    ).toBe(true);
    expect(validate({ action: "inspect", first: "x" })).toBe(false);
    expect(validate({ action: "inspect", fourth: "x".repeat(41) })).toBe(false);
    expect(JSON.stringify(schema).length).toBeLessThan(650);
  });

  it("requires every output union branch to declare concrete fields", () => {
    const concrete = {
      type: "object",
      properties: { item: { type: "string" } },
    };
    expect(concreteOutputSchema({ anyOf: [concrete, concrete] })).toBe(true);
    expect(
      concreteOutputSchema({
        anyOf: [concrete, { type: "object", additionalProperties: true }],
      }),
    ).toBe(false);
    expect(concreteOutputSchema({ type: "object", properties: {} })).toBe(
      false,
    );
    const intersection: JsonObject = {
      allOf: [
        { $ref: "#/definitions/item" },
        { type: "object", required: ["item"] },
      ],
      definitions: { item: concrete },
    };
    expect(concreteOutputSchema(intersection)).toBe(true);
    expect(
      concreteOutputSchema({ anyOf: [intersection, { type: "object" }] }),
    ).toBe(false);
  });
  it("removes fixture-only mock keys recursively", () => {
    const stripped = stripMockFromJsonSchema({
      type: "object",
      properties: {
        name: { type: "string", mock: "food.ingredient" },
        nested: { type: "object", properties: { id: { mock: "uuid" } } },
      },
    });

    expect(stripped).toEqual({
      type: "object",
      properties: {
        name: { type: "string" },
        nested: { type: "object", properties: { id: {} } },
      },
    });
  });

  it("keeps non-object output validation while making it SDK-safe", async () => {
    const output = z.union([
      z.object({ total: z.number() }),
      z.object({ items: z.array(z.string()) }),
    ]);
    const server = new McpServer({ name: "test", version: "1.0.0" });
    registerTestTool(server, {
      name: "union_out",
      kind: "query",
      input: z.object({}),
      output,
      run: async () => ({ total: 3 }),
    });

    const result = await callMcpTool(
      server,
      "union_out",
      { action: "run" },
      {},
    );
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({ total: 3 });
  });

  it("keeps legacy refusal codes in error metadata outside success-only structured content", async () => {
    const server = new McpServer({ name: "test", version: "1.0.0" });
    const capture = vi.fn(() => "unexpected-capture");
    registerTestTool(server, {
      name: "legacy_refusal",
      kind: "query",
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      run: async () => {
        throw Object.assign(
          new Error("Invalid identifier", {
            cause: { reason: "INVALID_INPUT" },
          }),
          { code: "BAD_REQUEST" },
        );
      },
    });
    const result = await withErrorReporting(
      () => callMcpTool(server, "legacy_refusal", { action: "run" }, {}),
      undefined,
      capture,
    );
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(result._meta).toMatchObject({
      "cubby/error": {
        code: "BAD_REQUEST",
        reason: "INVALID_INPUT",
        message: "Invalid identifier",
        diagnostics: { operation: "legacy_refusal.run", stage: "run" },
      },
    });
    expect(capture).not.toHaveBeenCalled();
  });

  it("marks calendar state dirty only after a successful mutating tool", async () => {
    const server = new McpServer({ name: "test", version: "1.0.0" });
    const markCalendarDirty = vi.fn();
    registerTestTool(
      server,
      {
        name: "calendar_affecting_write",
        kind: "mutation",
        input: z.object({}),
        output: z.object({ ok: z.boolean() }),
        run: async () => ({ ok: true }),
      },
      observedMcpRuntime({ markCalendarDirty }),
    );
    await callMcpTool(
      server,
      "calendar_affecting_write",
      { action: "run" },
      {},
    );
    expect(markCalendarDirty).toHaveBeenCalledWith(
      "mcp.calendar_affecting_write.run",
    );

    const readServer = new McpServer({ name: "test", version: "1.0.0" });
    registerTestTool(
      readServer,
      {
        name: "calendar_read",
        kind: "query",
        input: z.object({}),
        output: z.object({ ok: z.boolean() }),
        run: async () => ({ ok: true }),
      },
      observedMcpRuntime({ markCalendarDirty }),
    );
    await callMcpTool(readServer, "calendar_read", { action: "run" }, {});
    expect(markCalendarDirty).toHaveBeenCalledTimes(1);

    const failingServer = new McpServer({ name: "test", version: "1.0.0" });
    registerTestTool(
      failingServer,
      {
        name: "calendar_failed_write",
        kind: "mutation",
        input: z.object({}),
        output: z.object({ ok: z.boolean() }),
        run: async () => {
          throw new Error("write failed");
        },
      },
      observedMcpRuntime({ markCalendarDirty }),
    );
    await callMcpTool(
      failingServer,
      "calendar_failed_write",
      { action: "run" },
      {},
    );
    expect(markCalendarDirty).toHaveBeenCalledTimes(1);
  });

  it("records a possible write when output validation fails after the handler", async () => {
    const server = new McpServer({ name: "test", version: "1.0.0" });
    const recordDatabaseWrite = vi.fn(async () => {});
    registerTestTool(
      server,
      {
        name: "write_with_invalid_output",
        kind: "mutation",
        input: z.object({}),
        output: z.object({ ok: z.boolean() }),
        run: async () =>
          fromAny<{ ok: boolean }, { ok: string }>({ ok: "invalid" }),
      },
      observedMcpRuntime({ recordDatabaseWrite }),
    );

    const result = await callMcpTool(
      server,
      "write_with_invalid_output",
      { action: "run" },
      {},
    );

    expect(result.isError).toBe(true);
    expect(recordDatabaseWrite).toHaveBeenCalledWith(
      "write_with_invalid_output.run",
    );
  });

  it("publishes concrete, mock-free input and output schemas for the live catalog", async () => {
    const { tools } = catalog;
    const looseOutputs = new Set(["ai_read", "maintenance_read"]);
    const emptyProperties = <TSchema>(schema: TSchema) => {
      const properties = schemaProperties(schema);
      return properties !== undefined && Object.keys(properties).length === 0;
    };

    expect(
      tools.filter((tool) => !tool.outputSchema).map((tool) => tool.name),
    ).toEqual([]);
    expect(
      tools
        .filter(
          (tool) =>
            schemaHasMock(tool.inputSchema) || schemaHasMock(tool.outputSchema),
        )
        .map((tool) => tool.name),
    ).toEqual([]);
    expect(
      tools
        .filter(
          (tool) =>
            emptyProperties(tool.inputSchema) ||
            tool.inputSchema === undefined ||
            schemaProperties(tool.inputSchema) === undefined,
        )
        .map((tool) => tool.name),
    ).toEqual([]);
    expect(
      tools
        .filter(
          (tool) =>
            !looseOutputs.has(tool.name) &&
            !concreteOutputSchema(parseJson(tool.outputSchema)),
        )
        .map((tool) => tool.name),
    ).toEqual([]);
  });

  // Regression: #2741 added compact-read fields (preheader, images,
  // structured data, paging) and every member session's Email read failed
  // client-side output validation with "must NOT have additional properties".
  it("accepts a compact Email read in the published purchase_import_read output schema", async () => {
    const tool = catalog.tools.find(
      (candidate) => candidate.name === "purchase_import_read",
    );
    if (!tool?.outputSchema)
      throw new Error("Missing purchase_import_read output");
    const validate = new Ajv({ strict: false, validateFormats: true }).compile(
      tool.outputSchema,
    );
    const read = {
      mailboxId: "member@example.com",
      messageId: "synthetic-message",
      id: "EML-4K7M",
      threadId: null,
      checksum: "a".repeat(64),
      sender: "orders@vendor.example",
      subject: "Your order SYN-1001",
      receivedAt: "2026-02-01T12:00:00.000Z",
      content: {
        snippet: null,
        preheader: "Your synthetic order is confirmed",
        bodyText: "Synthetic shoe $104.00",
        textBytes: 22,
        bodyHtml: null,
        nextOffset: null,
        headers: { from: "orders@vendor.example" },
        htmlBytes: 2048,
        compacted: true,
        truncated: false,
        links: [{ href: "https://vendor.example/p/1", text: "Shoe" }],
        linksOmitted: 0,
        images: [{ src: "https://img.vendor.example/1.jpg", alt: "Shoe" }],
        imagesOmitted: 0,
        structuredData: ['{"@type":"Order"}'],
        structuredDataOmitted: 0,
        headersOmitted: false,
        bodyShortened: false,
      },
      attachments: [],
      boundToRun: false,
      purchaseIds: [],
      purchaseAssociations: [],
      acceptedSourceOrders: [],
      financialAssociations: [],
    };
    const valid = validate(read);
    expect(validate.errors ?? []).toEqual([]);
    expect(valid).toBe(true);
    // A client holding this schema keeps working when a later release adds
    // an output field: published outputs are open objects.
    expect(
      validate({
        ...read,
        addedLater: true,
        content: { ...read.content, addedLater: 1 },
      }),
    ).toBe(true);
  });

  it("publishes valid Draft-7 schemas with resolvable references and empty merchant candidate tuples", async () => {
    const validator = new Ajv({ strict: false, validateFormats: false });
    const invalid: string[] = [];
    for (const tool of catalog.tools) {
      for (const field of ["inputSchema", "outputSchema"] as const) {
        if (!validator.validateSchema(tool[field] ?? {})) {
          invalid.push(`${tool.name}.${field}`);
        } else {
          validator.compile(tool[field] ?? {});
        }
      }
    }
    expect(invalid).toEqual([]);
    // This compiles every advertised input and output graph, not one schema.
  }, 15_000);

  it.each([
    { candidates: z.tuple([]), accepted: [], rejected: ["candidate"] },
    {
      candidates: z.tuple([]).rest(z.string()),
      accepted: ["candidate"],
      rejected: [1],
    },
  ])(
    "preserves empty-prefix tuple validation in advertised schemas",
    (fixture) => {
      const schema = safeToJsonSchema(
        z.object({ candidates: fixture.candidates }),
        "output",
      );
      const validator = new Ajv({ strict: false, validateFormats: false });
      const validate = validator.compile(schema);
      expect(validate({ candidates: fixture.accepted })).toBe(true);
      expect(validate({ candidates: fixture.rejected })).toBe(false);
    },
  );

  it("keeps public entity-id fields self-describing in the published schemas", async () => {
    const uuidExceptions = new Set([
      // delete/bulkUpdate take one kind's ids; the kernel checks each against
      // that kind's shortcode, since one flat `ids` serves every kind.
      "entity.ids",
      "entity.data.externalIds[].id",
      "entity.data.sections[].id",
      "entity.data.sections[].ingredients[].id",
      "entity.data.sections[].instructions[].id",
      "entity.data.unitMappings[].id",
      // Bulk patches retain the ordinary child-row shape; these optional ids
      // identify collection children, never shortcode entities.
      "entity.data.unitMappings[].value.id",
      "entity.data.sections[].key.id",
      "entity.data.sections[].key.ingredients[].id",
      "entity.data.sections[].key.instructions[].id",
      // entity.commands items are the same create/update commands, so they
      // carry the same child-row ids (the ones an update edits in place).
      "entity.commands[].data.externalIds[].id",
      "entity.commands[].data.sections[].id",
      "entity.commands[].data.sections[].ingredients[].id",
      "entity.commands[].data.sections[].instructions[].id",
      "entity.commands[].data.unitMappings[].id",
      // Product resolve lines carry retailer/catalog identifiers (ASIN, SKU),
      // not Cubby entity ids.
      "entity_read.lines[].externalIds[].id",
      "entity_read.filters.mailboxId",
      // An Image job joins image-processing submissions by their `IPS-` public
      // id; a submission is a child row, not a shortcode entity.
      "entity_read.filters.submissionId",
      // A tree list's children scope names a parent of the listed entity's own
      // kind, so no single prefix pattern fits.
      "entity_read.nesting.parentId",
      // Agent-facing operation inputs preserve opaque row, idempotency and
      // source-evidence handles; entity references remain self-describing where
      // the operation has a single entity kind. Polymorphic references use a
      // separate discriminator, so no one shortcode prefix can describe them.
      "activity.resolve_run_finding.id",
      "ai.apply_finance_category_suggestion.entityId",
      "ai.pause_suggestion_sweep.runId",
      "ai.resume_suggestion_sweep.runId",
      "ai_read.suggest_fields.entityId",
      "field_explanation.explain.entityId",
      "maintenance.classify_image_provenance.afterId",
      "maintenance_read.logs.jobId",
      "nutrition.remove_food.id",
      "nutrition.remove_recipe.id",
      "nutrition.save_food.id",
      "nutrition.save_preparation.mealRecipeId",
      "nutrition.update_recipe.id",
      "photo_run.reject_candidate.operationId",
      "product_enrichment.merge_product_match.assessmentId",
      "purchase_import.commit.prepareOperationId",
      "purchase_import.commit.resolutions[].stableOrderId",
      "purchase_import.commit.resolutions[].stableLineId",
      "purchase_import.commit_accepted_reconciliation.sourceOrderId",
      "purchase_import.commit_accepted_reconciliation.reviewedPreparation.stableOrderId",
      "purchase_import_read.mail_import_outcomes.mailboxId",
      "purchase_import_read.mail_import_outcomes.messageId",
      "purchase_import_read.mail_read.mailboxId",
      "purchase_import_read.mail_read.messageId",
      "purchase_import_read.mail_read.attachmentId",
      "purchase_import.mail_resolve.mailboxId",
      "purchase_import.mail_resolve.messageId",
      "purchase_import.mail_resolve.disposition.via[].mailboxId",
      "purchase_import.mail_resolve.disposition.via[].messageId",
      "purchase_import.mail_search.mailboxId",
      "purchase_import_read.mail_triage_preview.mailboxId",
      "purchase_import_read.mail_triage_preview.messageId",
      "purchase_import.prepare.orders[].stableOrderId",
      "purchase_import.prepare.orders[].itemOperationId",
      "purchase_import.prepare.orders[].via[].mailboxId",
      "purchase_import.prepare.orders[].via[].messageId",
      "purchase_import.prepare.orders[].lineIds",
      "purchase_import.prepare_reconciliation.id",
      "purchase_import.prepare_reconciliation.sourceOrderId",
      "recipe_insights.patch_line.lineId",
      "recipe_insights.reparse_line.lineId",
      "run.commit_prepared.prepareOperationId",
      "run.commit_prepared.resolutions[].stableOrderId",
      "run.commit_prepared.resolutions[].stableLineId",
      "run.commit_prepared.operationId",
      "run.discover_mail.mailboxId",
      "run.set_mail_import.mailboxId",
      "shipments.edit_observation.observationId",
      "shipments.reassign.sourcePackageId",
      "suggestions_read.automatic_decisions.recordIds",
      "suggestions_read.list.recordIds",
      "suggestions.review.operationId",
      // Preview consumes the same opaque Assessment review handle as acceptance.
      "finance_read.preview_suggestion.assessmentId",
      "suggestions.review.assessmentId",
      "suggestions.review_batch.items[].operationId",
      "suggestions.review_batch.items[].assessmentId",
    ]);
    const freeTextIds = new Set([
      "orderId",
      "externalId",
      "expectedExternalId",
      "externalAccountId",
      "providerId",
      // Opaque upstream account/transaction keys are source evidence, never
      // Cubby FinancialAccount/FinancialTransaction ids or shortcodes.
      "providerTransactionId",
      "providerAccountId",
      // Device.installationId (and the photo-import commit's top-level
      // `deviceId`, which is the same installation id, not a `DEV-`
      // shortcode) is the native app's own local identifier — never a
      // public Cubby entity reference.
      "installationId",
      // Usage analytics records the authenticated account and browser client;
      // neither value addresses a Cubby entity.
      "userId",
      "clientId",
    ]);
    const violations: string[] = [];
    // Every published Ledger Party filter must accept `@me` (ADR 0018): the
    // clients offer "Me" on each one, so a shortcode-only schema rejects it.
    const partyFiltersWithoutMe: string[] = [];
    const stillExceptional = new Set<string>();
    const compiled = compiledMcpTools(MCP_TOOL_BINDINGS, MCP_TOOL_DECLARATIONS);
    for (const tool of catalog.tools) {
      const fullInputs = KERNEL_TOOLS.has(tool.name)
        ? [{ prefix: tool.name, schema: parseJsonObject(tool.inputSchema) }]
        : (() => {
            const binding = compiled.find(
              (candidate) => candidate.name === tool.name,
            );
            if (!binding)
              throw new Error(`${tool.name} has no compiled MCP tool`);
            return describeMcpActions(binding, [
              ...binding.actions.keys(),
            ]).actions.map(({ action, inputSchema }) => ({
              prefix: `${tool.name}.${action}`,
              schema: parseJsonObject(inputSchema),
            }));
          })();
      for (const { prefix, schema } of fullInputs) {
        const definitionsCandidate = schema.$defs ?? schema.definitions;
        const definitions =
          definitionsCandidate && isJsonObject(definitionsCandidate)
            ? definitionsCandidate
            : {};
        const fields: IdField[] = [];
        collectIdFields(schema, "", fields, definitions);
        for (const { path, node } of fields) {
          const key = `${prefix}.${path}`;
          const leaf = path.split(".").at(-1)?.replaceAll("[]", "") ?? "";
          if (freeTextIds.has(leaf)) continue;
          const missingPattern = stringSchemas(node, definitions).some(
            (stringSchema) => {
              const pattern = stringSchema.pattern;
              return (
                pattern === undefined ||
                !isString(pattern) ||
                !PUBLIC_SHORTCODE_PREFIXES.some((prefix) =>
                  pattern.includes(prefix),
                )
              );
            },
          );
          // `ids` selects the listed kind's own records, not a person filter.
          if (
            path.startsWith("filters.") &&
            leaf !== "ids" &&
            stringSchemas(node, definitions).some(
              ({ pattern }) =>
                pattern !== undefined &&
                isString(pattern) &&
                pattern.includes("LPY-") &&
                !pattern.includes("@me"),
            )
          )
            partyFiltersWithoutMe.push(key);
          if (uuidExceptions.has(key)) {
            if (missingPattern) stillExceptional.add(key);
          } else if (missingPattern) {
            violations.push(key);
          }
        }
      }
    }
    expect(violations).toEqual([]);
    expect(partyFiltersWithoutMe).toEqual([]);
    expect(
      [...uuidExceptions].filter((key) => !stillExceptional.has(key)).sort(),
    ).toEqual([]);
  });
});

/** Kernel tools keep full schemas; capability tools publish compact envelopes
 * and return a selected member schema through progressive disclosure. */
const KERNEL_SCHEMA_BUDGET = 143_360;
const WORKFLOW_SCHEMA_BUDGET = 2_048;
const KERNEL_TOOLS = new Set(["entity", "entity_read"]);

function isObject(value: JSONType | undefined): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Every `$ref` target and every `properties` map in a schema tree. */
function schemaFaults(schema: JsonObject): string[] {
  const definitions = isObject(schema.$defs)
    ? schema.$defs
    : isObject(schema.definitions)
      ? schema.definitions
      : {};
  const faults: string[] = [];
  const visit = (node: JSONType, path: string) => {
    if (Array.isArray(node)) {
      node.forEach((item, index) => visit(item, `${path}[${index}]`));
      return;
    }
    if (!isObject(node)) return;
    const ref = z.string().safeParse(node.$ref).data;
    if (ref) {
      const name = ref.replace(/^#\/(?:definitions|\$defs)\//u, "");
      if (!definitions[name]) faults.push(`${path}: dangling ${ref}`);
    }
    if (isObject(node.properties) && "$ref" in node.properties)
      faults.push(`${path}.properties is a $ref, not a map of schemas`);
    for (const [key, value] of Object.entries(node))
      visit(value, `${path}.${key}`);
  };
  visit(schema, "");
  return faults;
}

describe("MCP catalog publication without services", () => {
  it("marks a tool read-only only when every generated action is a query", async () => {
    const { tools } = catalog;
    for (const tool of tools) {
      const binding = Object.entries(MCP_TOOL_BINDINGS).find(
        ([name]) => name === tool.name,
      )?.[1];
      if (!binding) throw new Error(`${tool.name} has no generated binding`);
      const kinds = new Set(
        Object.values(binding.actions).map((action) => action.kind),
      );
      expect(tool.annotations?.readOnlyHint).toBe(
        [...kinds].every((kind) => kind === "query"),
      );
    }
  });

  it("keeps each published input schema portable and under its budget", async () => {
    const { tools } = catalog;
    const oversized: string[] = [];
    for (const tool of tools) {
      const schema = z.json().parse(tool.inputSchema);
      if (!isObject(schema)) throw new Error(`${tool.name}: no object schema`);
      // Anthropic rejects anyOf/oneOf/allOf at the ROOT of input_schema.
      expect([tool.name, schema.type, "anyOf" in schema]).toEqual([
        tool.name,
        "object",
        false,
      ]);
      expect("oneOf" in schema || "allOf" in schema).toBe(false);
      expect(schema.required).toEqual(
        KERNEL_TOOLS.has(tool.name) ? ["action"] : ["action", "input"],
      );
      expect(schemaFaults(schema)).toEqual([]);
      const size = JSON.stringify(schema).length;
      const budget = KERNEL_TOOLS.has(tool.name)
        ? KERNEL_SCHEMA_BUDGET
        : WORKFLOW_SCHEMA_BUDGET;
      if (size > budget) oversized.push(`${tool.name}: ${size} > ${budget}`);
    }
    expect(oversized).toEqual([]);
  });

  // Codex validates `pattern` with a regex engine that has no lookaround, so a
  // lookaround pattern rejects every value there. Keep such rules in a refine.
  it("publishes only lookaround-free patterns", async () => {
    const lookaround: string[] = [];
    const visit = (node: JSONType, path: string) => {
      if (Array.isArray(node)) {
        node.forEach((item, index) => visit(item, `${path}[${index}]`));
        return;
      }
      if (!isObject(node)) return;
      for (const [key, value] of Object.entries(node)) {
        if (key === "pattern" && isString(value) && /\(\?<?[=!]/.test(value))
          lookaround.push(`${path}: ${value}`);
        else visit(value, `${path}.${key}`);
      }
    };
    for (const tool of catalog.tools)
      visit(z.json().parse(tool.inputSchema), tool.name);
    expect(lookaround).toEqual([]);
  });
});
