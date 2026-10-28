import { timestampField } from "./field-policy";
import { imageDescriptionInputs } from "./image-description-inputs";
import { defineEntity, defineEntityModel } from "./definition.js";
import { displayItemsField } from "./label-field.js";
import { productShortcode, wishShortcode } from "../identifier-fields.js";
import {
  wishCandidateOut,
  wishPriceRangeOut,
} from "@cubby/schemas/wish-fields";
import { z } from "zod";
export const { definition, readSchemas } = defineEntityModel({
  key: "wish",
  names: { singular: "Wish", plural: "Wishlist" },
  route: {
    listColumns: {
      module: "~/features/wish/list-columns",
      export: "wishListOverride",
    },
    basePath: "wishes",
  },
  table: "Wish",
  identifiers: { brand: "WishId", shortcode: "WSH-" },
  presentation: {
    titleField: "name",
    domain: "purchases",
    description: "Wanted items and candidate products.",
    emptyState: {
      title: "No wishes yet",
      description:
        "Keep an idea open-ended or compare a few Products before deciding.",
      actionLabel: "Add Wish",
    },
    icons: { phosphor: "Heart", sfSymbol: "star", emoji: "⭐" },
    detail: {
      summary: [
        {
          kind: "fields",
          id: "acquired",
          title: "Acquired",
          fields: ["acquiredAt"],
        },
        {
          kind: "records",
          id: "candidate-products",
          title: "Candidate Products",
          viewKey: "relation:candidates",
        },
        {
          kind: "fields",
          id: "candidate-price-range",
          title: "Candidate price range",
          fields: ["priceRange"],
        },
        {
          kind: "fields",
          id: "decision-notes",
          title: "Decision notes",
          fields: ["notes"],
        },
      ],

      omitRelations: {
        candidates:
          "The Candidate alternatives section edits candidates in place with its own renderer.",
      },
      hero: { extraActions: ["markPurchased"] },
      sections: [
        {
          kind: "fields",
          id: "overview",
          title: "Record",
          fields: ["name", "notes"],
        },
        {
          kind: "fields",
          id: "coverage",
          title: "Coverage and summaries",
          fields: ["acquiredAt", "createdAt", "updatedAt"],
        },
        {
          kind: "fields",
          id: "candidates",
          title: "Candidate alternatives",
          fields: ["candidates"],
        },
      ],
    },
    list: {
      savedViews: [
        {
          id: "hide-acquired",
          label: "Hide acquired",
          description: "Only items still on the list",
          filters: [{ id: "acquiredAt", value: "false" }],
        },
      ],
      extraActions: ["markPurchased"],
      totals: [
        {
          id: "priceRange",
          label: "Price range",
          keys: ["priceLow", "priceHigh"],
          format: "currencyRange",
        },
      ],
    },
  },
  model: {
    fields: [
      {
        key: "name",
        kind: "text",
        control: { kind: "text" },
        display: { standard: "name" },
        validation: {
          read: z.string().trim().min(1).max(200),
          create: z.string().trim().min(1).max(200),
          update: z.string().trim().min(1).max(200).optional(),
        },
      },
      {
        key: "notes",
        kind: "text",
        nullable: true,
        control: { kind: "textarea" },
        display: { columnGroup: "Decision", width: "xl" },
        validation: {
          read: z.string().nullable(),
          create: z.string().nullable().default(null),
          update: z.string().nullable().optional(),
        },
      },
      {
        output: false,
        key: "candidateProductIds",
        kind: "identifier",
        reference: { entity: "product", multiple: true },
        control: { kind: "specialized", renderer: "entity-multi-select" },
        collection: { key: "value", readPath: "candidates[].id" },
        validation: {
          read: null,
          create: z.array(productShortcode).default([]),
          update: z.array(productShortcode).optional(),
        },
      },
      {
        output: false,
        audit: false,
        key: "acquired",
        kind: "boolean",
        control: { kind: "checkbox" },
        provenance: {
          kind: "relation",
          sources: [{ entity: "product", relation: "candidates" }],
        },
        validation: {
          read: null,
          create: null,
          update: z.boolean().optional(),
        },
      },
      {
        display: { detail: false, list: false },
        key: "id",
        kind: "identifier",
        validation: {
          read: wishShortcode,
          create: null,
          update: null,
        },
      },
      {
        audit: true,
        key: "acquiredAt",
        kind: "timestamp",
        nullable: true,
        display: {
          columnGroup: "Decision",
          valueOptions: [
            {
              value: "acquired",
              label: "Acquired",
              color: "positive",
            },
            {
              value: "wanted",
              label: "Wanted",
              color: "neutral-status",
            },
          ],
          optionRole: "status",
          optionColor: "neutral-status",
        },
        validation: {
          read: z.date().nullable(),
          create: null,
          update: null,
        },
      },
      {
        key: "candidates",
        kind: "json",
        display: {
          list: false,
          itemsPath: "candidateItems",
          renderer: { detail: "wish-candidates" },
          valueOptions: [
            {
              value: "yes",
              label: "In inventory",
              color: "positive",
            },
            {
              value: "no",
              label: "Not stocked",
              color: "neutral-status",
            },
          ],
          optionRole: "status",
          optionColor: "neutral-status",
        },
        provenance: {
          kind: "relation",
          sources: [{ entity: "product", relation: "candidates" }],
        },
        explanation: {
          ruleId: "wish.candidates",
          description:
            "Candidates are the live product relationships currently recorded for this wish.",
          readPath: "candidates",
          sourceDependencies: [
            { path: "candidates", label: "Candidate products" },
          ],
        },
        validation: {
          read: z.array(wishCandidateOut),
          create: null,
          update: null,
        },
      },
      {
        display: { detail: false, list: false },
        key: "candidateCount",
        kind: "number",
        provenance: {
          kind: "derived",
          sources: [{ entity: "product", relation: "candidates" }],
        },
        explanation: {
          ruleId: "wish.candidate-count",
          description:
            "Option count is the number of live candidate products currently attached to this wish.",
          readPath: "candidateCount",
          sourceDependencies: [
            { path: "candidates", label: "Candidate products" },
          ],
        },
        validation: {
          read: z.number().int().nonnegative(),
          create: null,
          update: null,
        },
      },
      {
        display: { detail: false, list: false },
        key: "priceRange",
        kind: "json",
        nullable: true,
        provenance: {
          kind: "derived",
          sources: [{ entity: "product", relation: "candidates" }],
        },
        explanation: {
          ruleId: "wish.candidate-price-range",
          description:
            "Price range is the low and high effective price across priced live candidates; unpriced candidates are counted separately and excluded from the range.",
          readPath: "priceRange",
          sourceDependencies: [
            {
              path: "candidates",
              label: "Candidate products and effective prices",
            },
          ],
        },
        validation: {
          read: wishPriceRangeOut.nullable(),
          create: null,
          update: null,
        },
      },
      timestampField("createdAt"),
      timestampField("updatedAt"),
      { output: false, key: "shortcode", kind: "text" },
      { output: false, key: "deletedAt", kind: "timestamp", nullable: true },
      // Server-composed rows for the candidates above (`display.itemsPath`).
      displayItemsField("candidateItems", "Candidate products"),
    ],
    storage: [
      {
        key: "id",
        specialized: "primary-key:WishId",
      },
      { key: "shortcode", specialized: "shortcode" },
      "name",
      "notes",
      "acquiredAt",
      { key: "createdAt" },
      { key: "updatedAt", specialized: "updated-at" },
      "deletedAt",
    ],

    derived: {
      // The midpoint of the candidates' price range.
      priceRange: { type: "number" },
      // The range's bounds, summed by the declared `priceRange` total.
      priceLow: { type: "number" },
      priceHigh: { type: "number" },
      candidateName: { via: "candidates.name" },
      candidateManufacturer: { via: "candidates.brand.name" },
      candidateModel: { via: "candidates.model" },
    },
    sort: {
      fields: ["name", "acquiredAt", "priceRange", "createdAt", "updatedAt"],
    },
    intents: {
      fields: {
        // A wish has nothing worth deferring: capture is the full form.
        capture: ["name", "notes", "candidateProductIds", "acquired"],
        full: ["name", "notes", "candidateProductIds", "acquired"],
        identity: ["name", "notes", "candidateProductIds"],
        acquisition: ["acquired"],
      },
      create: ["capture", "full"],
      update: ["full", "identity", "acquisition"],
    },
  },
  fields: {
    list: {
      module: "@cubby/schemas/wish-raw-read",
      export: "rawWishListItemOut",
    },
  },
  storage: {
    indexes: [{ on: ["createdAt"] }, { on: ["acquiredAt"] }],
  },
  filters: {
    audit: true,
    schema: { module: "@cubby/schemas/wish", export: "wishFilterFields" },
    descriptors: [
      {
        columnId: "name",
        field: "search",
        urlKey: "q",
        kind: "text",
        placeholder: "Search wishlist...",
        deriveSchema: true,
        schemaFromRead: true,
        anyOf: [
          "name",
          "notes",
          "candidateName",
          "candidateManufacturer",
          "candidateModel",
        ],
      },
      {
        columnId: "acquiredAt",
        field: "acquired",
        urlKey: "acquired",
        wire: { kind: "param", name: "acquired" },
        kind: "boolean",
        placeholder: "Filter by status...",
        deriveSchema: true,
        stored: { columns: ["acquiredAt"] },
        options: [
          { value: "false", label: "Wanted" },
          { value: "true", label: "Acquired" },
        ],
      },
      {
        columnId: "related:wish.candidates",
        field: "productId",
        urlKey: "related-product",
        kind: "idMulti",
        placeholder: "Filter by candidate product...",
        optionsKey: "wishCandidates",
        brandRef: { entity: "product" },
        nullable: { field: "productPresenceFilter", label: "candidate" },
      },
    ],
  },

  search: {
    mode: "semantic",
    inputs: [
      ...imageDescriptionInputs("wish"),

      {
        table: "EntityLink",
        match: { fromEntityId: "id" },
        where: { kind: "wishCandidate" },
      },
      {
        table: "Product",
        match: { id: "id" },
        columns: ["name", "model", "brandId", "deletedAt"],
        path: [
          {
            table: "EntityLink",
            from: "toEntityId",
            to: "fromEntityId",
            where: { kind: "wishCandidate" },
          },
        ],
      },
      {
        table: "Vendor",
        match: { id: "id" },
        columns: ["name", "deletedAt"],
        path: [
          { table: "Product", from: "brandId", to: "id" },
          {
            table: "EntityLink",
            from: "toEntityId",
            to: "fromEntityId",
            where: { kind: "wishCandidate" },
          },
        ],
      },
    ],
  },
  capabilities: {
    images: {
      storage: false,
      displaySourceOverrides: [
        {
          relationPath: ["candidates"],
        },
      ],
      ingress: [
        {
          kind: "existingRelated",
          routeId: "wish-product",
          relationPath: ["candidates"],
          choice: "primary",
        },
        {
          kind: "createSelf",
          routeId: "wish-new",
          enabled: false,
          disabledReason:
            "Wishes have no image storage of their own; attach photos via the candidate product instead",
        },
      ],
      routing: {
        category: "home",
        candidateFields: ["name", "notes"],
        temporalFields: [],
        lifecycleFilters: [{ field: "acquired", equals: false }],
        signals: { ocrFields: ["name", "notes"], classifierLabels: ["gift"] },
        abstention: { minimumScore: 0.78, minimumMargin: 0.16 },
      },
    },
    delete: { mode: "soft", bulk: true },
    merge: false,
    dataQuality: {
      inputs: [
        {
          table: "EntityLink",
          match: { fromEntityId: "id" },
          columns: ["deletedAt", "toEntityId"],
          path: [{ table: "Wish", from: "id", to: "id" }],
          where: { kind: "wishCandidate" },
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
              where: { kind: "wishCandidate" },
            },
            { table: "Wish", from: "id", to: "id" },
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
              where: { kind: "wishCandidate" },
            },
            { table: "Wish", from: "id", to: "id" },
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
              where: { kind: "wishCandidate" },
            },
            { table: "Wish", from: "id", to: "id" },
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
              where: { kind: "wishCandidate" },
            },
            { table: "Wish", from: "id", to: "id" },
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
              where: { kind: "wishCandidate" },
            },
            { table: "Wish", from: "id", to: "id" },
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
              where: { kind: "wishCandidate" },
            },
            { table: "Wish", from: "id", to: "id" },
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
              where: { kind: "wishCandidate" },
            },
            { table: "Wish", from: "id", to: "id" },
          ],
        },
      ],

      checks: [
        {
          id: "wish_candidate",
          satisfiedLabel: "Candidate recorded",
          placement: { section: "candidates" },
          facet: "linkage",
          weight: 1,
          label: "Candidate",
          message: "No live candidate product is linked to this wish.",
        },
      ],
    },
  },
  extensions: {
    ports: {
      repository: {
        module: "~/server/domains/wish/repo",
        export: "wishRepository",
      },
      search: "document",
    },
  },
});

export default defineEntity(
  definition,
  (r) => [
    r
      .link("wishCandidate", "outgoing")
      .named("candidates", "Candidate products", {
        view: { columnGroup: "Options", defaultVisible: true },
      }),
  ],
  readSchemas,
);
