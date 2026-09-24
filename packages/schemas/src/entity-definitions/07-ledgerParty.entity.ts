import { defineEntity } from "./definition.js";
import { ledgerPartyShortcode } from "../identifier-fields.js";
import { ledgerPartyKind } from "@cubby/schemas/ledger-party-fields";
import { z } from "zod";
export default defineEntity({
  key: "ledgerParty",
  names: { singular: "Ledger Party", plural: "Ledger Parties" },
  route: { basePath: "ledger-parties" },
  table: "LedgerParty",
  identifiers: { brand: "LedgerPartyId", shortcode: "LPY-" },
  presentation: {
    titleField: "name",
    domain: "finance",
    description: "People represented in the contribution ledger.",
    emptyState: {
      title: "No ledger parties yet",
      description:
        "Household members, guests, and the household itself as a whole show up here once a contribution or transfer names them.",
    },
    icons: { phosphor: "Users", sfSymbol: "person.2", emoji: "👤" },
    detail: {
      omitRelations: {
        "recipes-eaten":
          "Reachable through the Meals table on this page; the recipe rollup is three joins deep.",
      },
      additionalSectionOverrides: [
        { kind: "slot", id: "wardrobe", title: "Wardrobe" },
      ],
    },
    // Merge is a kernel capability with no browser operation yet.
  },
  model: {
    fields: [
      {
        key: "name",
        kind: "text",
        control: { kind: "text" },
        display: { list: true, detail: true },
        validation: {
          read: z.string(),
          create: z.string().trim().min(1, "Ledger party name is required"),
          update: z
            .string()
            .trim()
            .min(1, "Ledger party name is required")
            .optional(),
        },
      },
      {
        key: "kind",
        kind: "enum",
        control: { kind: "select" },
        display: { list: true, detail: true },
        validation: {
          read: ledgerPartyKind,
          create: ledgerPartyKind,
          update: ledgerPartyKind.optional(),
        },
      },
      {
        key: "notes",
        kind: "text",
        nullable: true,
        control: { kind: "textarea" },
        display: { list: true, detail: true },
        validation: {
          read: z.string().nullable(),
          create: z.string().nullable().default(null),
          update: z.string().nullable().optional(),
        },
      },
      {
        key: "id",
        kind: "identifier",
        validation: {
          read: ledgerPartyShortcode,
          create: null,
          update: null,
        },
      },
      {
        key: "createdAt",
        kind: "timestamp",
        display: { detail: true },
        validation: {
          read: z.date(),
          create: null,
          update: null,
        },
      },
      {
        key: "updatedAt",
        kind: "timestamp",
        display: { detail: true },
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
        specialized: "primary-key:LedgerPartyId",
      },
      { key: "shortcode", specialized: "shortcode" },
      "name",
      { key: "kind", specialized: "enum:kind" },
      "notes",
      { key: "createdAt" },
      { key: "updatedAt", specialized: "updated-at" },
      "deletedAt",
    ],
    create: ["name", "kind", "notes"],
    update: ["name", "kind", "notes"],
    bulk: [],
    audit: ["name", "kind", "notes"],
    sort: {
      fields: ["name", "kind", "createdAt", "updatedAt"],
      // A name roster reads A→Z, unlike the blanket descending default.
    },
    intents: {
      fields: {
        full: ["name", "kind", "notes"],
      },
      create: ["full"],
      update: ["full"],
    },
    output: ["id", "name", "kind", "notes", "createdAt", "updatedAt"],
  },
  fields: {
    create: {
      module: "@cubby/schemas/ledger-party",
      export: "ledgerPartyCreateInput",
    },
    update: {
      module: "@cubby/schemas/ledger-party",
      export: "ledgerPartyUpdateData",
    },
    output: { module: "@cubby/schemas/ledger-party", export: "ledgerPartyOut" },
  },
  filters: {
    audit: true,
    schema: {
      module: "@cubby/schemas/ledger-party",
      export: "ledgerPartyFilterFields",
    },
    descriptors: [
      {
        columnId: "name",
        field: "search",
        urlKey: "q",
        kind: "text",
        placeholder: "Search ledger parties...",
        deriveSchema: true,
        stored: true,
      },
      {
        columnId: "kind",
        kind: "multiselect",
        placeholder: "Filter by kind...",
        deriveSchema: true,
        stored: true,
        schemaRef: {
          module: "@cubby/schemas/ledger-party-fields",
          export: "ledgerPartyKind",
        },
        options: [
          { value: "member", label: "Member" },
          { value: "guest", label: "Guest" },
          { value: "household", label: "Household" },
        ],
      },
      {
        columnId: "related:ledgerParty.meals",
        field: "mealSearch",
        urlKey: "related-meal",
        kind: "text",
        placeholder: "Search related meals...",
      },
      {
        columnId: "mealId",
        kind: "idMulti",
        placeholder: "Filter by related meals id...",
        brandRef: { entity: "meal" },
        urlOnly: true,
      },
      {
        columnId: "mealPresenceFilter",
        kind: "presence",
        placeholder: "Filter related meals presence...",
        urlOnly: true,
      },
      {
        columnId: "related:ledgerParty.recipesEaten",
        field: "recipeSearch",
        urlKey: "related-recipe",
        kind: "text",
        placeholder: "Search related recipes...",
      },
      {
        columnId: "recipeId",
        kind: "idMulti",
        placeholder: "Filter by related recipes id...",
        brandRef: { entity: "recipe" },
        urlOnly: true,
      },
      {
        columnId: "recipePresenceFilter",
        kind: "presence",
        placeholder: "Filter related recipes presence...",
        urlOnly: true,
      },
    ],
  },
  relations: [
    {
      key: "expenses",
      label: "Attributed expenses",
      target: "expense",
      cardinality: "many",
      provenance: {
        kind: "local-path",
        steps: [
          { edge: "ExpenseAttribution.ledgerPartyId", direction: "incoming" },
          { edge: "ExpenseAttribution.expenseId", direction: "outgoing" },
        ],
      },
      inverse: {
        steps: [
          { edge: "ExpenseAttribution.expenseId", direction: "incoming" },
          { edge: "ExpenseAttribution.ledgerPartyId", direction: "outgoing" },
        ],
      },
    },
    {
      key: "financial-accounts",
      label: "Financial accounts",
      target: "financialAccount",
      cardinality: "many",
      provenance: {
        kind: "local-path",
        steps: [
          { edge: "FinancialAccount.ledgerPartyId", direction: "incoming" },
        ],
      },
      inverse: {
        steps: [
          { edge: "FinancialAccount.ledgerPartyId", direction: "outgoing" },
        ],
      },
    },
    {
      key: "outgoing-transfers",
      label: "Outgoing transfers",
      target: "ledgerTransfer",
      cardinality: "many",
      provenance: {
        kind: "local-path",
        steps: [{ edge: "LedgerTransfer.fromPartyId", direction: "incoming" }],
      },
      inverse: {
        steps: [{ edge: "LedgerTransfer.fromPartyId", direction: "outgoing" }],
      },
    },
    {
      key: "incoming-transfers",
      label: "Incoming transfers",
      target: "ledgerTransfer",
      cardinality: "many",
      provenance: {
        kind: "local-path",
        steps: [{ edge: "LedgerTransfer.toPartyId", direction: "incoming" }],
      },
      inverse: {
        steps: [{ edge: "LedgerTransfer.toPartyId", direction: "outgoing" }],
      },
    },
    {
      key: "meals",
      label: "Meals eaten",
      target: "meal",
      cardinality: "many",
      sourceKey: "food-entries",
      provenance: {
        kind: "local-path",
        steps: [
          { edge: "MealFoodEntry.ledgerPartyId", direction: "incoming" },
          { edge: "MealFoodEntry.mealId", direction: "outgoing" },
        ],
      },
      inverse: {
        steps: [
          { edge: "MealFoodEntry.mealId", direction: "incoming" },
          { edge: "MealFoodEntry.ledgerPartyId", direction: "outgoing" },
        ],
      },
      sources: [
        {
          key: "portions",
          label: "Served portions",
          provenance: {
            kind: "local-path",
            steps: [
              {
                edge: "MealRecipePortion.ledgerPartyId",
                direction: "incoming",
              },
              { edge: "MealRecipePortion.mealId", direction: "outgoing" },
            ],
          },
          inverse: {
            steps: [
              { edge: "MealRecipePortion.mealId", direction: "incoming" },
              {
                edge: "MealRecipePortion.ledgerPartyId",
                direction: "outgoing",
              },
            ],
          },
        },
      ],
    },
    {
      key: "recipes-eaten",
      label: "Recipes eaten",
      target: "recipe",
      cardinality: "many",
      provenance: {
        kind: "local-path",
        steps: [
          { edge: "MealRecipePortion.ledgerPartyId", direction: "incoming" },
          { edge: "MealRecipePortion.mealRecipeId", direction: "outgoing" },
          { edge: "MealRecipe.recipeId", direction: "outgoing" },
        ],
      },
      inverse: {
        steps: [
          { edge: "MealRecipe.recipeId", direction: "incoming" },
          { edge: "MealRecipePortion.mealRecipeId", direction: "incoming" },
          { edge: "MealRecipePortion.ledgerPartyId", direction: "outgoing" },
        ],
      },
    },
  ],
  search: { enabled: false },
  capabilities: {
    auditable: true,
    images: { storage: false },
    countable: false,
    softDelete: true,
    delete: { mode: "soft", bulk: true },
    bulkUpdate: null,
    merge: true,
    operationOwners: { delete: "kernel", merge: "kernel" },
    mcp: ["get", "list", "create", "update", "delete", "merge"],
    dataQuality: {
      checks: [
        {
          id: "ledger_party_financial_account",
          facet: "linkage",
          weight: 1,
          label: "Financial account",
          message: "No financial account is linked to this member.",
        },
      ],
    },
  },
  extensions: {
    mcpNames: { plural: "ledger_parties" },
    ports: {
      repository: {
        module: "~/server/repo/ledger-party.entity-adapter",
        export: "ledgerPartyEntityAdapter",
      },
    },
  },
});
