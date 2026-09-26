import type { Entity } from "@cubby/schemas/entity";
import { entityRelationshipSchema } from "@cubby/schemas/entity-integrity";
import { allEntities, entityManifest } from "@cubby/schemas/entity-manifest";
import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { INCOMING_EDGES } from "~/server/db/entity-incoming-edges";
import * as schema from "~/server/db/schema";

const entities = allEntities;
type SchemaExport = (typeof schema)[keyof typeof schema];
type SchemaTable = Extract<SchemaExport, PgTable>;
const isSchemaTable = (value: SchemaExport): value is SchemaTable =>
  is(value, PgTable);

// Every real pgTable schema.ts exports — entity tables (Recipe, Product, …)
// AND join/child tables (RecipeSection, ProductImage, PurchaseImage, …) and
// the Better-Auth tables alike. Sourcing FK introspection from here (not a
// hand-picked subset of entity tables) is what makes a join table
// indistinguishable from an entity table AS A SOURCE — the old hand-maintained
// `ENTITY_TABLE` iterated only entity tables, so it was structurally blind to
// `PurchaseImage.imageId` (a join-table column) ever going undeclared. See the
// file-level doc comment on entity-incoming-edges.ts for the fuller rationale.
const ALL_TABLES = Object.values(schema).filter(isSchemaTable);

// entity -> its own local pgTable, resolved by matching the manifest's
// declared `dbTable` name against the real exported tables — derived, not
// hand-maintained, so the two can't quietly drift apart (see the first test).
const ENTITY_TABLE: Partial<Record<Entity, PgTable>> = {};
for (const entity of entities) {
  const dbTable = entityManifest[entity].dbTable;
  if (!dbTable) continue;
  const table = ALL_TABLES.find((t) => getTableConfig(t).name === dbTable);
  if (table) ENTITY_TABLE[entity] = table;
}

// pgTable name (e.g. "Purchase") -> entity (e.g. "purchase"), for resolving an
// FK's target table back to the entity it belongs to (only entities have a
// local table; join/child tables never appear on the right-hand side here).
const ENTITY_BY_TABLE = new Map<string, Entity>();
for (const entity of entities) {
  const table = ENTITY_TABLE[entity];
  if (!table) continue;
  ENTITY_BY_TABLE.set(getTableConfig(table).name, entity);
}

// FK targets that are real pgTables but deliberately NOT entities — each
// needs a one-line reason here, which is the point of assertion 3 below: a
// NEW non-entity FK target fails until someone adds (and justifies) an entry.
//
// schema.ts re-exports the Better-Auth / OAuth-provider tables (auth.schema.ts)
// for the drizzle adapter, so "every pgTable exported from schema.ts" (the
// introspection source; see ALL_TABLES above) pulls in that whole auth
// sub-graph too — not just `user` (AuditLog.userId's target). Auth's own
// internal edges (session -> user, oauth_refresh_token -> oauth_client, etc.)
// all need an entry here as well, since none of them are app-domain entities.
const NON_ENTITY_FK_TARGETS = {
  // Durable identity (ADR 0006): every payload binds to its own row, and an
  // attachment names its subject here because a subject can be any entity.
  Entity: "durable identity, not a domain entity of its own",
  // Owned wholly by its parent recipe (Recipe -> RecipeSection ->
  // RecipeSectionIngredient) — not independently addressable, so it never
  // graduated to its own entity.
  RecipeSection: "owned wholly by its recipe, not independently addressable",
  MealRecipe:
    "a UUID-addressed recipe occurrence owned by its meal, not an entity",
  // Background-job bookkeeping (queue/inline processing metadata), not a
  // domain entity a user ever looks up by id.
  BackgroundBatch: "operational bookkeeping, not a domain entity",
  // Better-Auth / OAuth-provider tables (auth.schema.ts) — infrastructure for
  // sign-in and MCP OAuth 2.1, not app-domain entities. Referenced (directly
  // or transitively) by AuditLog.userId and the oauth_* tables' own edges.
  user: "Better-Auth's own table, referenced only by AuditLog.userId",
  session: "Better-Auth's own table (login sessions)",
  oauth_client: "OAuth 2.1 provider table (registered MCP clients)",
  oauth_resource: "OAuth 2.1 provider table (protected resource policy)",
  oauth_refresh_token: "OAuth 2.1 provider table (issued refresh tokens)",
  // The provider-statement ledger: verbatim evidence Cubby is compared
  // against, deliberately not entities. At 15k+ rows they would swamp global
  // semantic search, and they carry no shortcode because nothing links to a
  // statement line by public id.
  StatementImport: "provider export bookkeeping, not a domain entity",
  StatementRow: "verbatim statement evidence, not a domain entity",
  RunTarget:
    "explicit operational target for a validation, enrichment or photo-inventory import run",
  RunOrderCandidate:
    "an account-sync run's order-history worklist, not a domain entity",
  ImportPreparedOrder:
    "immutable purchase-import evidence preparation, not a domain entity",
  ImportSourceClaim: "idempotency provenance for imported evidence",
  ImageDerivative: "a non-gallery representation owned by its original Image",
  ImageProcessingJob:
    "authoritative operational image work, exposed through Activity",
  ImageProcessingSubmission:
    "fixed membership of an explicit image-processing request",
  OrderMail: "normalized mailbox evidence, not a domain entity",
};

/**
 * Entity-targeting FKs normally belong to a declared local graph path (or its
 * inverse). These non-entity source tables only carry owned/metadata state, so
 * rendering a relationship branch for them would expose implementation rows
 * rather than a navigable record relationship. Keeping the reason beside each
 * exemption makes a new FK fail closed, and makes an obsolete exemption fail
 * once its edge becomes graph-visible.
 */
const NON_GRAPH_ENTITY_FK_EXEMPTIONS = {
  // Caller attribution. AuditLog and AiUsage are append-only telemetry, not
  // entities, so the device/run they name is recorded provenance, not a
  // navigable relationship.
  "AuditLog.deviceId": {
    classification: "metadata",
    reason: "records the Apple install a write came from",
  },
  "AuditLog.runId": {
    classification: "metadata",
    reason: "records the Run a write belonged to",
  },
  "AiUsage.runId": {
    classification: "metadata",
    reason: "records the Run a model call belonged to",
  },
  "RunTarget.purchaseId": {
    classification: "metadata",
    reason: "records the Purchase a targeted validation examined",
  },
  "PhotoGroupProposal.runId": {
    classification: "ownership",
    reason: "a photo-inventory run's proposed item groupings",
  },
  "PhotoGroupProposal.productId": {
    classification: "metadata",
    reason: "the Product a proposed photo group chose or committed to",
  },
  "PhotoGroupProposal.inventoryLocationId": {
    classification: "metadata",
    reason: "where a proposed photo group's inventory will be received",
  },
  "PhotoGroupProposal.inventoryOwnerPartyId": {
    classification: "metadata",
    reason: "the member a proposed photo group's inventory will belong to",
  },
  "PhotoGroupProposal.productCreateCategoryId": {
    classification: "metadata",
    reason: "the category a proposed photo group's new Product is filed under",
  },
  "RunTarget.productId": {
    classification: "metadata",
    reason: "records the Product a targeted enrichment examined",
  },
  "RunTarget.imageId": {
    classification: "metadata",
    reason: "records the Image a photo-inventory run grouped into a Product",
  },
  "RunTarget.vendorAccountId": {
    classification: "metadata",
    reason:
      "freezes the member-owned vendor account selected for targeted evidence",
  },
  // run's own child rows. Each source table is operational
  // bookkeeping (see NON_ENTITY_FK_TARGETS above), not an entity, so these
  // stay ordinary non-graph exemptions rather than needing a declared
  // relationship. `Purchase.runId` and `Run.predecessorRunId`
  // are NOT exempted here on purpose: both source purchase and
  // run, which are entities, so the guard below correctly
  // demands a real graph path for them (as it already does for
  // `Run.ledgerPartyId`/`vendorAccountId`/`vendorId`) — declaring one
  // needs a `relations` entry on the entity definitions plus `pnpm generate`,
  // which is out of scope here; see the failing case this leaves in
  // "accounts for every entity-targeting FK with a graph path or classified
  // non-entity edge".
  "RunTarget.runId": {
    classification: "ownership",
    reason: "a validation/enrichment target exists only as part of its run",
  },
  "RunOrderCandidate.runId": {
    classification: "ownership",
    reason: "an account-sync order-history worklist row owned by its run",
  },
  "RunEvidence.runId": {
    classification: "ownership",
    reason: "captured evidence filed under its run",
  },
  "RunMutation.runId": {
    classification: "ownership",
    reason: "an explicit row-mutation record attributed to its run",
  },
  "RunOperation.runId": {
    classification: "ownership",
    reason: "one idempotent operation owned by its run",
  },
  "RunProgress.runId": {
    classification: "ownership",
    reason: "a progress checkpoint owned by its run",
  },
  "RunControlEvent.runId": {
    classification: "ownership",
    reason: "a control-plane event (pause/resume/prompt/...) owned by its run",
  },
  "RunApproval.runId": {
    classification: "ownership",
    reason: "an approval decision owned by its run",
  },
  "ImportSourceClaim.firstRunId": {
    classification: "metadata",
    reason: "records the run that first captured this idempotent source claim",
  },
  "ImportSourceClaim.lastRunId": {
    classification: "metadata",
    reason:
      "records the run that most recently confirmed this idempotent source claim",
  },
  "RunFinding.runId": {
    classification: "metadata",
    reason: "records the run that produced this integrity finding",
  },
  "ImportHunt.receiptRunId": {
    classification: "metadata",
    reason: "records the run that captured this hunt's receipt",
  },
  "ImportPreparedOrder.runId": {
    classification: "ownership",
    reason: "immutable prepared-order evidence owned by its run",
  },
  "ImportPreparedOrder.primaryDocumentImageId": {
    classification: "metadata",
    reason: "immutable prepared evidence retains its primary source document",
  },
  "ImportPreparedOrder.screenshotImageId": {
    classification: "metadata",
    reason: "immutable prepared evidence retains its browser screenshot",
  },
  "ImportSourceClaim.ledgerPartyId": {
    classification: "metadata",
    reason: "scopes import provenance to a household member",
  },
  "ImportSourceClaim.vendorAccountId": {
    classification: "metadata",
    reason: "records which vendor login supplied the evidence",
  },
  "ImportSourceClaim.purchaseId": {
    classification: "metadata",
    reason: "idempotency provenance for the purchase created from evidence",
  },
  "RunFinding.ledgerPartyId": {
    classification: "metadata",
    reason: "scopes an operational review finding to a household member",
  },
  "ImportHunt.ledgerPartyId": {
    classification: "metadata",
    reason: "scopes receipt discovery work to a household member",
  },
  "ImportHunt.financialTransactionId": {
    classification: "metadata",
    reason: "receipt-discovery work keyed by its triggering transaction",
  },
  "ImportHunt.vendorId": {
    classification: "metadata",
    reason: "candidate vendor metadata for receipt discovery",
  },
  "ImportHunt.vendorAccountId": {
    classification: "metadata",
    reason: "vendor login selected for receipt discovery",
  },
  "ImportHunt.receiptImageId": {
    classification: "metadata",
    reason: "submitted evidence retained by receipt-discovery work",
  },
  "MerchantVendorRule.ledgerPartyId": {
    classification: "metadata",
    reason: "member-scoped merchant classification rule",
  },
  "MerchantVendorRule.vendorId": {
    classification: "metadata",
    reason: "merchant classification rule output",
  },
  "MailboxCursor.ledgerPartyId": {
    classification: "metadata",
    reason: "member-scoped mailbox synchronization checkpoint",
  },
  "OrderMail.ledgerPartyId": {
    classification: "metadata",
    reason: "member-scoped normalized mailbox evidence",
  },
  "OrderMail.vendorId": {
    classification: "metadata",
    reason: "classified vendor for normalized mailbox evidence",
  },
  "OrderMailAttachment.imageId": {
    classification: "metadata",
    reason: "normalized mail attachment stored as image evidence",
  },
  "ImageDerivative.imageId": {
    classification: "ownership",
    reason: "a non-gallery transparent representation is owned by its original",
  },
  "ImageProcessingJob.imageId": {
    classification: "metadata",
    reason: "durable processing state is operational metadata for the original",
  },
  "ImageDescriptionCorrection.imageId": {
    classification: "metadata",
    reason: "a user-confirmed description is owned by the image it describes",
  },
  "PurchasePaymentEvidence.purchaseId": {
    classification: "metadata",
    reason: "payment matching evidence owned by a purchase",
  },
  "LedgerSourceClaim.expenseId": {
    classification: "metadata",
    reason: "ledger reconciliation provenance, not a navigable domain record",
  },
  "LedgerSourceClaim.ledgerTransferId": {
    classification: "metadata",
    reason: "ledger reconciliation provenance, not a navigable domain record",
  },
  "ProductConversionCoverage.productId": {
    classification: "ownership",
    reason: "derived conversion-coverage state owned by the product",
  },
  "ProductMatchCandidate.productAId": {
    classification: "metadata",
    reason: "review queue state for a candidate same-item pair",
  },
  "ProductMatchCandidate.productBId": {
    classification: "metadata",
    reason: "review queue state for a candidate same-item pair",
  },
  "ProductExternalId.productId": {
    classification: "metadata",
    reason: "external provider identifier owned by the product",
  },
  "ProductUnitMappings.productId": {
    classification: "ownership",
    reason: "derived unit-mapping state owned by the product",
  },
  "StatementRow.accountId": {
    classification: "metadata",
    reason: "verbatim imported banking evidence, not a navigable entity",
  },
} as const satisfies Record<
  string,
  { classification: "metadata" | "ownership"; reason: string }
>;

interface IntrospectedEdge {
  /** `${sourceTableName}.${sourceColumnName}`, e.g. "EntityAttachment.imageId". */
  key: string;
  sourceEntity: Entity | undefined;
  targetTableName: string;
  targetEntity: Entity | undefined;
}

/** Every FK column in schema.ts, source table included (join tables too). */
function introspectFkEdges(): IntrospectedEdge[] {
  const edges: IntrospectedEdge[] = [];
  for (const table of ALL_TABLES) {
    const sourceTableName = getTableConfig(table).name;
    const sourceEntity = ENTITY_BY_TABLE.get(sourceTableName);
    for (const fk of getTableConfig(table).foreignKeys) {
      const ref = fk.reference();
      const targetTableName = getTableConfig(ref.foreignTable).name;
      const targetEntity = ENTITY_BY_TABLE.get(targetTableName);
      for (const column of ref.columns) {
        edges.push({
          key: `${sourceTableName}.${column.name}`,
          sourceEntity,
          targetTableName,
          targetEntity,
        });
      }
    }
  }
  return edges;
}

/** Every FK named by a local graph path or its declared inverse. */
function graphPathEdgeKeys(): ReadonlySet<string> {
  const keys = new Set<string>();
  const add = (
    steps: readonly { edge: string; direction: "outgoing" | "incoming" }[],
  ) => {
    for (const step of steps) keys.add(step.edge);
  };
  for (const entity of entities) {
    for (const literal of entityManifest[entity].relationships) {
      const relationship = entityRelationshipSchema.parse(literal);
      const sources = [
        {
          provenance: relationship.provenance,
          inverse: relationship.inverse,
        },
        ...relationship.sources,
      ];
      for (const source of sources) {
        if (source.provenance.kind === "local-path")
          add(source.provenance.steps);
        if (source.inverse) add(source.inverse.steps);
      }
    }
  }
  return keys;
}

describe("entity manifest FK guard", () => {
  it("every entity's declared dbTable resolves to a real pgTable in schema.ts", () => {
    for (const entity of entities) {
      const dbTable = entityManifest[entity].dbTable;
      if (!dbTable) continue;
      const table = ENTITY_TABLE[entity];
      expect(
        table,
        `entityManifest.${entity}.dbTable = "${dbTable}" does not match any pgTable exported from schema.ts`,
      ).toBeDefined();
      if (!table) continue;
      expect(getTableConfig(table).name).toBe(dbTable);
    }
  });

  it("every FK pointing at an entity's table is declared in INCOMING_EDGES", () => {
    const edges = introspectFkEdges().filter(
      (
        edge,
      ): edge is IntrospectedEdge & {
        targetEntity: Entity;
      } => edge.targetEntity !== undefined,
    );
    // Introspection actually found FKs targeting entities — an empty result
    // here would mean this test is vacuously (and silently) passing.
    expect(edges.length).toBeGreaterThan(0);
    const missing = edges
      .filter((edge) => !(edge.key in INCOMING_EDGES[edge.targetEntity]))
      .map(
        (e) =>
          `\`${e.key}\` references ${e.targetTableName} but is not declared in \`INCOMING_EDGES.${e.targetEntity}\`.`,
      );
    expect(missing).toEqual([]);
  });

  it("every declared INCOMING_EDGES entry matches a real FK, or is marked unconstrained", () => {
    const found = new Set(introspectFkEdges().map((e) => e.key));
    const missing: string[] = [];
    for (const entity of entities) {
      for (const [key, edge] of Object.entries(INCOMING_EDGES[entity])) {
        if (edge.unconstrained) continue;
        if (!found.has(key)) {
          missing.push(
            `INCOMING_EDGES.${entity}["${key}"] has no matching FK in schema.ts — a typo, a renamed column, or it should be marked \`unconstrained: true\`.`,
          );
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it("every FK target is either an entity or an allowlisted non-entity table", () => {
    const unexplained = introspectFkEdges()
      .filter(
        (e) => !e.targetEntity && !(e.targetTableName in NON_ENTITY_FK_TARGETS),
      )
      .map(
        (e) =>
          `\`${e.key}\` references ${e.targetTableName}, which is neither an entity table nor in NON_ENTITY_FK_TARGETS — add it there with a one-line reason, or point it at an entity.`,
      );
    expect(unexplained).toEqual([]);
  });

  it("accounts for every entity-targeting FK with a graph path or classified non-entity edge", () => {
    const edges = introspectFkEdges();
    const graphEdges = graphPathEdgeKeys();
    const edgesByKey = new Map(edges.map((edge) => [edge.key, edge]));
    const missing = edges
      .filter(
        (
          edge,
        ): edge is IntrospectedEdge & {
          targetEntity: Entity;
        } => edge.targetEntity !== undefined,
      )
      .filter(
        (edge) =>
          !graphEdges.has(edge.key) &&
          !(edge.key in NON_GRAPH_ENTITY_FK_EXEMPTIONS),
      )
      .map(
        (edge) =>
          `\`${edge.key}\` targets ${edge.targetEntity}, but no graph path/inverse names it and it has no NON_GRAPH_ENTITY_FK_EXEMPTIONS classification.`,
      );
    const stale = Object.entries(NON_GRAPH_ENTITY_FK_EXEMPTIONS).flatMap(
      ([key, exemption]) => {
        const edge = edgesByKey.get(key);
        if (!edge)
          return [`\`${key}\` is exempted but is no longer a schema FK.`];
        if (!edge.targetEntity)
          return [`\`${key}\` is exempted but does not target an entity.`];
        if (edge.sourceEntity)
          return [
            `\`${key}\` is exempted even though its source is entity ${edge.sourceEntity}; declare a graph path instead.`,
          ];
        if (graphEdges.has(key))
          return [`\`${key}\` is exempted but is now named by a graph path.`];
        if (exemption.reason.trim().length === 0)
          return [`\`${key}\` has an empty exemption reason.`];
        return [];
      },
    );
    expect([...missing, ...stale]).toEqual([]);
  });
});

/**
 * The claim `relationships` makes that the old flat `references: Entity[]`
 * could not: not just THAT recipe reaches ingredient, but through exactly which
 * foreign keys, in which direction. That turns a doc comment into something
 * Drizzle's own metadata can adjudicate — the join-table and multi-hop entries
 * were previously unguarded by any test at all.
 */
describe("relationship provenance", () => {
  /** `Table.column` -> the table that FK points AT. Every FK in schema.ts. */
  const FK_TARGET = new Map<string, string>();
  for (const edge of introspectFkEdges()) {
    FK_TARGET.set(edge.key, edge.targetTableName);
  }

  /**
   * An FK to `Entity` (an attachment's subject) lands on whichever entity
   * tables declare it in INCOMING_EDGES; ids are unique across them.
   */
  const landingTables = (edgeKey: string): string[] => {
    const target = FK_TARGET.get(edgeKey);
    if (target !== "Entity") return target === undefined ? [] : [target];
    return entities.flatMap((entity) => {
      const table = entityManifest[entity].dbTable;
      return table && edgeKey in INCOMING_EDGES[entity] ? [table] : [];
    });
  };

  /** One walker step; `finalTable` resolves an outgoing multi-target edge. */
  const stepFrom = (
    at: string,
    step: { edge: string; direction: "outgoing" | "incoming" },
    finalTable: string | null,
  ): { at: string } | { error: string } => {
    const targets = landingTables(step.edge);
    if (targets.length === 0)
      return { error: `\`${step.edge}\` is not a real FK.` };
    const holder = sourceTableOf(step.edge);
    if (step.direction === "outgoing") {
      if (holder !== at)
        return {
          error: `outgoing \`${step.edge}\` starts on ${holder}, not ${at}.`,
        };
      if (targets.length === 1) return { at: targets[0]! };
      return finalTable !== null && targets.includes(finalTable)
        ? { at: finalTable }
        : { error: `outgoing \`${step.edge}\` has several targets.` };
    }
    return targets.includes(at)
      ? { at: holder }
      : {
          error: `incoming \`${step.edge}\` targets ${targets.join(" | ")}, not ${at}.`,
        };
  };

  /** The table a step's edge lives ON — the left half of its `Table.column` key. */
  const sourceTableOf = (edgeKey: string): string => {
    const [table] = edgeKey.split(".");
    return table ?? "";
  };

  it("walks every local path across real FKs, landing on the declared target", () => {
    const failures: string[] = [];

    for (const entity of entities) {
      const startTable = entityManifest[entity].dbTable;
      for (const rel of entityManifest[entity].relationships) {
        if (rel.provenance.kind !== "local-path") continue;
        const where = `${entity}.${rel.key}`;

        if (!startTable) {
          failures.push(
            `${where}: source entity has no dbTable to start from.`,
          );
          continue;
        }

        // Walk it. `at` is the table we are standing on; each step must be an
        // FK that actually touches it, and moves us to the other end.
        let at: string = startTable;
        let broke = false;
        const finalTable = entityManifest[rel.target].dbTable;
        for (const [index, step] of rel.provenance.steps.entries()) {
          const next = stepFrom(
            at,
            step,
            index === rel.provenance.steps.length - 1 ? finalTable : null,
          );
          if ("error" in next) {
            failures.push(`${where}: ${next.error}`);
            broke = true;
            break;
          }
          at = next.at;
        }
        if (broke) continue;

        const declared = entityManifest[rel.target].dbTable;
        if (at !== declared) {
          failures.push(
            `${where}: path ends on ${at}, but target "${rel.target}" is ${declared}.`,
          );
        }
      }
    }

    expect(failures).toEqual([]);
  });

  it("validates every named provenance source and its inverse path", () => {
    const failures: string[] = [];
    const walk = (
      start: string,
      steps: readonly { edge: string; direction: "outgoing" | "incoming" }[],
      where: string,
      finalTable: string | null = null,
    ): string | null => {
      let at = start;
      for (const [index, step] of steps.entries()) {
        const next = stepFrom(
          at,
          step,
          index === steps.length - 1 ? finalTable : null,
        );
        if ("error" in next) {
          failures.push(`${where}: ${next.error}`);
          return null;
        }
        at = next.at;
      }
      return at;
    };

    for (const entity of entities) {
      const sourceTable = entityManifest[entity].dbTable;
      if (!sourceTable) continue;
      for (const literal of entityManifest[entity].relationships) {
        const relationship = entityRelationshipSchema.parse(literal);
        const targetTable = entityManifest[relationship.target].dbTable;
        const sources = [
          {
            key: relationship.sourceKey ?? relationship.key,
            provenance: relationship.provenance,
            inverse: relationship.inverse,
          },
          ...relationship.sources,
        ];
        for (const source of sources) {
          if (source.provenance.kind !== "local-path") continue;
          const where = `${entity}.${relationship.key}[${source.key}]`;
          expect(source.inverse, `${where} has no inverse`).toBeDefined();
          if (!source.inverse || !targetTable) continue;
          expect(
            walk(sourceTable, source.provenance.steps, where, targetTable),
          ).toBe(targetTable);
          expect(
            walk(
              targetTable,
              source.inverse.steps,
              `${where}.inverse`,
              sourceTable,
            ),
          ).toBe(sourceTable);
        }
      }
    }

    expect(failures).toEqual([]);
  });

  it("backs every unconstrained relationship with an edge marked unconstrained", () => {
    const failures: string[] = [];
    for (const entity of entities) {
      for (const literal of entityManifest[entity].relationships) {
        const rel = entityRelationshipSchema.parse(literal);
        const sources = [
          { key: rel.sourceKey ?? rel.key, provenance: rel.provenance },
          ...rel.sources,
        ];
        for (const source of sources) {
          const { provenance } = source;
          if (provenance.kind !== "unconstrained") continue;
          const { edge } = provenance;
          // It must NOT be a real FK (that's what unconstrained means) and it
          // must be declared as such on the target's incoming edges.
          if (FK_TARGET.has(edge)) {
            failures.push(
              `${entity}.${rel.key}[${source.key}]: \`${edge}\` IS a real FK — declare it as a local-path instead.`,
            );
            continue;
          }
          const declared = Object.entries(INCOMING_EDGES[rel.target]).find(
            ([key]) => key === edge,
          )?.[1];
          if (
            !declared ||
            !("unconstrained" in declared) ||
            declared.unconstrained !== true
          ) {
            failures.push(
              `${entity}.${rel.key}[${source.key}]: \`${edge}\` is not marked \`unconstrained\` in INCOMING_EDGES.${rel.target}.`,
            );
          }
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it("names real source columns on every external relationship", () => {
    // No FK to check (the other system has no table here), so the guard is
    // that the columns carrying the link actually exist.
    const COLUMNS = new Set<string>();
    for (const table of ALL_TABLES) {
      const config = getTableConfig(table);
      for (const column of config.columns) {
        COLUMNS.add(`${config.name}.${column.name}`);
      }
    }

    const failures: string[] = [];
    for (const entity of entities) {
      for (const literal of entityManifest[entity].relationships) {
        const rel = entityRelationshipSchema.parse(literal);
        const sources = [
          { key: rel.sourceKey ?? rel.key, provenance: rel.provenance },
          ...rel.sources,
        ];
        for (const source of sources) {
          if (source.provenance.kind !== "external") continue;
          for (const column of source.provenance.sourceColumns) {
            if (!COLUMNS.has(column)) {
              failures.push(
                `${entity}.${rel.key}[${source.key}]: \`${column}\` is not a real column in schema.ts.`,
              );
            }
          }
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it("is not vacuous — the multi-hop and join-table paths are actually present", () => {
    // The traversal above passes trivially if nobody declares a multi-step
    // path, which is exactly the state this whole change exists to leave.
    const steps = entities.flatMap((e) =>
      entityManifest[e].relationships
        .filter((r) => r.provenance.kind === "local-path")
        .map((r) =>
          r.provenance.kind === "local-path" ? r.provenance.steps.length : 0,
        ),
    );
    expect(Math.max(...steps)).toBeGreaterThanOrEqual(4); // recipe → sub-recipes
    expect(steps.filter((n) => n === 2).length).toBeGreaterThanOrEqual(6); // image galleries
  });
});
