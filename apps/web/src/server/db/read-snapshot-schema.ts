import type { StoredFieldDecision } from "@cubby/schemas/derived-value";
import { emailRelationshipResult } from "@cubby/schemas/email-relationship-facts";
import type { Entity } from "@cubby/schemas/entity";
import { expenseBeneficiaryResult } from "@cubby/schemas/expense-beneficiaries";
import {
  storedProductOwnership,
  storedInventoryOwnership,
} from "@cubby/schemas/inventory-ownership";
import { locationValuation } from "@cubby/schemas/location-fields";
import { productReadFacts } from "@cubby/schemas/product-read-fields";
import { projectRollupResult } from "@cubby/schemas/project-output-fields";
import { shipmentEventSummarySchema } from "@cubby/schemas/shipment-fields";
import { workDiagnosticFacts } from "@cubby/schemas/work-diagnostic-facts";
import { foodSummary } from "@cubby/usda";
import {
  pgTable,
  uuid,
  text,
  jsonb,
  doublePrecision,
  timestamp,
  foreignKey,
} from "drizzle-orm/pg-core";
import type { z } from "zod";

import { entityIdentity } from "./entity-identity-schema";

/** Disposable product read results with independently published, typed columns. */
export const productReadSnapshot = pgTable(
  "ProductReadSnapshot",
  {
    entityId: uuid("entityId").primaryKey(),
    kind: text("kind").$type<Entity>().notNull().default("product"),
    price: doublePrecision("price"),
    priceDecision: jsonb("priceDecision").$type<StoredFieldDecision>(),
    priceComputedAt: timestamp("priceComputedAt", { mode: "date" }),
    priceSort: doublePrecision("priceSort"),
    readFacts: jsonb("readFacts").$type<z.infer<typeof productReadFacts>>(),
    readFactsDecision: jsonb("readFactsDecision").$type<StoredFieldDecision>(),
    readFactsComputedAt: timestamp("readFactsComputedAt", { mode: "date" }),
    readFactsSort: text("readFactsSort"),
    food: jsonb("food").$type<z.infer<typeof foodSummary>>(),
    foodDecision: jsonb("foodDecision").$type<StoredFieldDecision>(),
    foodComputedAt: timestamp("foodComputedAt", { mode: "date" }),
    foodSort: text("foodSort"),
    ownership:
      jsonb("ownership").$type<z.infer<typeof storedProductOwnership>>(),
    ownershipDecision: jsonb("ownershipDecision").$type<StoredFieldDecision>(),
    ownershipComputedAt: timestamp("ownershipComputedAt", { mode: "date" }),
    ownershipSort: text("ownershipSort"),
  },
  (table) => [
    foreignKey({
      name: "ProductReadSnapshot_entityId_kind_Entity_id_kind_fk",
      columns: [table.entityId, table.kind],
      foreignColumns: [entityIdentity.id, entityIdentity.kind],
    }).onDelete("cascade"),
  ],
);

/** Disposable inventory read results with independently published, typed columns. */
export const inventoryReadSnapshot = pgTable(
  "InventoryReadSnapshot",
  {
    entityId: uuid("entityId").primaryKey(),
    kind: text("kind").$type<Entity>().notNull().default("inventory"),
    valuation: doublePrecision("valuation"),
    valuationDecision: jsonb("valuationDecision").$type<StoredFieldDecision>(),
    valuationComputedAt: timestamp("valuationComputedAt", { mode: "date" }),
    valuationSort: doublePrecision("valuationSort"),
    ownership:
      jsonb("ownership").$type<z.infer<typeof storedInventoryOwnership>>(),
    ownershipDecision: jsonb("ownershipDecision").$type<StoredFieldDecision>(),
    ownershipComputedAt: timestamp("ownershipComputedAt", { mode: "date" }),
    ownershipSort: text("ownershipSort"),
  },
  (table) => [
    foreignKey({
      name: "InventoryReadSnapshot_entityId_kind_Entity_id_kind_fk",
      columns: [table.entityId, table.kind],
      foreignColumns: [entityIdentity.id, entityIdentity.kind],
    }).onDelete("cascade"),
  ],
);

/** Disposable location read results with independently published, typed columns. */
export const locationReadSnapshot = pgTable(
  "LocationReadSnapshot",
  {
    entityId: uuid("entityId").primaryKey(),
    kind: text("kind").$type<Entity>().notNull().default("location"),
    valuationRollup:
      jsonb("valuationRollup").$type<z.infer<typeof locationValuation>>(),
    valuationRollupDecision: jsonb(
      "valuationRollupDecision",
    ).$type<StoredFieldDecision>(),
    valuationRollupComputedAt: timestamp("valuationRollupComputedAt", {
      mode: "date",
    }),
    valuationRollupSort: doublePrecision("valuationRollupSort"),
  },
  (table) => [
    foreignKey({
      name: "LocationReadSnapshot_entityId_kind_Entity_id_kind_fk",
      columns: [table.entityId, table.kind],
      foreignColumns: [entityIdentity.id, entityIdentity.kind],
    }).onDelete("cascade"),
  ],
);

/** Disposable project read results with independently published, typed columns. */
export const projectReadSnapshot = pgTable(
  "ProjectReadSnapshot",
  {
    entityId: uuid("entityId").primaryKey(),
    kind: text("kind").$type<Entity>().notNull().default("project"),
    completionYear: text("completionYear"),
    completionYearDecision: jsonb(
      "completionYearDecision",
    ).$type<StoredFieldDecision>(),
    completionYearComputedAt: timestamp("completionYearComputedAt", {
      mode: "date",
    }),
    completionYearSort: text("completionYearSort"),
    workDiagnosticFacts: jsonb("workDiagnosticFacts").$type<
      z.infer<typeof workDiagnosticFacts>
    >(),
    workDiagnosticFactsDecision: jsonb(
      "workDiagnosticFactsDecision",
    ).$type<StoredFieldDecision>(),
    workDiagnosticFactsComputedAt: timestamp("workDiagnosticFactsComputedAt", {
      mode: "date",
    }),
    workDiagnosticFactsSort: text("workDiagnosticFactsSort"),
    rollups: jsonb("rollups").$type<z.infer<typeof projectRollupResult>>(),
    rollupsDecision: jsonb("rollupsDecision").$type<StoredFieldDecision>(),
    rollupsComputedAt: timestamp("rollupsComputedAt", { mode: "date" }),
    rollupsSort: text("rollupsSort"),
  },
  (table) => [
    foreignKey({
      name: "ProjectReadSnapshot_entityId_kind_Entity_id_kind_fk",
      columns: [table.entityId, table.kind],
      foreignColumns: [entityIdentity.id, entityIdentity.kind],
    }).onDelete("cascade"),
  ],
);

/** Disposable expense read results with independently published, typed columns. */
export const expenseReadSnapshot = pgTable(
  "ExpenseReadSnapshot",
  {
    entityId: uuid("entityId").primaryKey(),
    kind: text("kind").$type<Entity>().notNull().default("expense"),
    beneficiaryResult:
      jsonb("beneficiaryResult").$type<
        z.infer<typeof expenseBeneficiaryResult>
      >(),
    beneficiaryResultDecision: jsonb(
      "beneficiaryResultDecision",
    ).$type<StoredFieldDecision>(),
    beneficiaryResultComputedAt: timestamp("beneficiaryResultComputedAt", {
      mode: "date",
    }),
    beneficiaryResultSort: text("beneficiaryResultSort"),
  },
  (table) => [
    foreignKey({
      name: "ExpenseReadSnapshot_entityId_kind_Entity_id_kind_fk",
      columns: [table.entityId, table.kind],
      foreignColumns: [entityIdentity.id, entityIdentity.kind],
    }).onDelete("cascade"),
  ],
);

/** Disposable email read results with independently published, typed columns. */
export const emailReadSnapshot = pgTable(
  "EmailReadSnapshot",
  {
    entityId: uuid("entityId").primaryKey(),
    kind: text("kind").$type<Entity>().notNull().default("email"),
    relationshipFacts:
      jsonb("relationshipFacts").$type<
        z.infer<typeof emailRelationshipResult>
      >(),
    relationshipFactsDecision: jsonb(
      "relationshipFactsDecision",
    ).$type<StoredFieldDecision>(),
    relationshipFactsComputedAt: timestamp("relationshipFactsComputedAt", {
      mode: "date",
    }),
    relationshipFactsSort: text("relationshipFactsSort"),
  },
  (table) => [
    foreignKey({
      name: "EmailReadSnapshot_entityId_kind_Entity_id_kind_fk",
      columns: [table.entityId, table.kind],
      foreignColumns: [entityIdentity.id, entityIdentity.kind],
    }).onDelete("cascade"),
  ],
);

/** Disposable shipment read results with independently published, typed columns. */
export const shipmentReadSnapshot = pgTable(
  "ShipmentReadSnapshot",
  {
    entityId: uuid("entityId").primaryKey(),
    kind: text("kind").$type<Entity>().notNull().default("shipment"),
    eventSummary:
      jsonb("eventSummary").$type<z.infer<typeof shipmentEventSummarySchema>>(),
    eventSummaryDecision: jsonb(
      "eventSummaryDecision",
    ).$type<StoredFieldDecision>(),
    eventSummaryComputedAt: timestamp("eventSummaryComputedAt", {
      mode: "date",
    }),
    eventSummarySort: text("eventSummarySort"),
  },
  (table) => [
    foreignKey({
      name: "ShipmentReadSnapshot_entityId_kind_Entity_id_kind_fk",
      columns: [table.entityId, table.kind],
      foreignColumns: [entityIdentity.id, entityIdentity.kind],
    }).onDelete("cascade"),
  ],
);
