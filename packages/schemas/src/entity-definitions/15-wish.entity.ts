import { defineEntity } from "./definition.js";
import { productShortcode, wishShortcode } from "../identifier-fields.js";
import { wishCandidateOut } from "@cubby/schemas/wish-fields";
import { z } from "zod";
export default defineEntity({
  key: "wish",
  names: { singular: "Wish", plural: "Wishlist" },
  route: { basePath: "wishes", create: "dialog", list: true, detail: true },
  table: "Wish",
  identifiers: { brand: "WishId", shortcode: "WSH-" },
  presentation: {
    titleField: "name",
    domain: "plan",
    description: "Wanted items and candidate products.",
    emptyState: {
      title: "No tool wishes yet",
      description:
        "Keep a tool idea open-ended or compare a few Products before deciding.",
      actionLabel: "Add Wish",
    },
    icons: { lucide: "Heart", sfSymbol: "star" },
    detail: {
      hero: { actions: ["edit", "markPurchased"] },
      sections: [
        {
          kind: "fields",
          id: "overview",
          title: "Overview",
          placement: "supporting",
          fields: ["name", "notes", "acquiredAt", "createdAt", "updatedAt"],
        },
        {
          kind: "fields",
          id: "candidates",
          title: "Tool alternatives",
          fields: ["candidates"],
        },
      ],
    },
    list: { actions: ["markPurchased", "delete"] },
  },
  model: {
    fields: [
      {
        key: "name",
        kind: "text",
        control: { kind: "text" },
        display: { list: true, detail: true, standard: "name" },
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
        display: { list: true, detail: true },
        validation: {
          read: z.string().nullable(),
          create: z.string().nullable().default(null),
          update: z.string().nullable().optional(),
        },
      },
      {
        key: "candidateProductIds",
        kind: "identifier",
        label: "Candidate Product IDs",
        readKey: null,
        reference: { entity: "product", multiple: true },
        control: { kind: "specialized", renderer: "entity-multi-select" },
        validation: {
          read: null,
          create: z.array(productShortcode).default([]),
          update: z.array(productShortcode).optional(),
        },
      },
      {
        key: "acquired",
        kind: "boolean",
        readKey: null,
        control: { kind: "checkbox", section: "details" },
        validation: {
          read: null,
          create: null,
          update: z.boolean().optional(),
        },
      },
      {
        key: "id",
        kind: "identifier",
        validation: {
          read: wishShortcode,
          create: null,
          update: null,
        },
      },
      {
        key: "acquiredAt",
        kind: "timestamp",
        nullable: true,
        // `acquired` is the persisted column id the status cell and the
        // boolean filter spec hang on.
        display: { list: true, detail: true, columnId: "acquired" },
        validation: {
          read: z.date().nullable(),
          create: null,
          update: null,
        },
      },
      {
        key: "candidates",
        kind: "json",
        display: { detail: true },
        validation: {
          read: z.array(wishCandidateOut),
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
      { key: "shortcode", kind: "text", readKey: null },
      { key: "deletedAt", kind: "timestamp", nullable: true, readKey: null },
    ],
    storage: [
      { key: "id", default: "generated", specialized: "primary-key:WishId" },
      { key: "shortcode", specialized: "shortcode" },
      "name",
      "notes",
      "acquiredAt",
      { key: "createdAt", default: "now" },
      { key: "updatedAt", default: "now", specialized: "updated-at" },
      "deletedAt",
    ],
    create: ["name", "notes", "candidateProductIds"],
    update: ["name", "notes", "candidateProductIds", "acquired"],
    bulk: [],
    audit: ["name", "notes", "acquiredAt", "candidateProductIds"],
    sort: {
      fields: ["name", "acquiredAt", "priceRange", "createdAt", "updatedAt"],
      default: "createdAt",
      computed: ["priceRange"],
    },
    intents: {
      fields: {
        capture: ["name"],
        full: ["name", "notes", "candidateProductIds", "acquired"],
        identity: ["name", "notes", "candidateProductIds"],
        acquisition: ["acquired"],
      },
      create: ["capture", "full"],
      update: ["full", "identity", "acquisition"],
    },
    output: [
      "id",
      "name",
      "notes",
      "acquiredAt",
      "candidates",
      "createdAt",
      "updatedAt",
    ],
  },
  fields: {
    create: { module: "@cubby/schemas/wish", export: "wishCreateInput" },
    update: { module: "@cubby/schemas/wish", export: "wishUpdateData" },
    output: { module: "@cubby/schemas/wish", export: "wishOut" },
    list: { module: "@cubby/schemas/wish", export: "wishListItemOut" },
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
      },
      {
        columnId: "acquired",
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
        field: "candidateProductId",
        urlKey: "related-product",
        kind: "idMulti",
        placeholder: "Filter by candidate product...",
        optionsKey: "wishCandidates",
        brandRef: { entity: "product" },
        nullable: { field: "productPresenceFilter", label: "candidate" },
      },
      {
        columnId: "productId",
        kind: "idMulti",
        placeholder: "Filter by candidate product id...",
        urlOnly: true,
      },
      {
        columnId: "productPresenceFilter",
        kind: "presence",
        placeholder: "Filter candidate presence...",
        urlOnly: true,
      },
    ],
  },
  relations: [
    {
      key: "candidates",
      label: "Tool candidates",
      target: "product",
      cardinality: "many",
      provenance: {
        kind: "local-path",
        steps: [
          { edge: "WishCandidate.wishId", direction: "incoming" },
          { edge: "WishCandidate.productId", direction: "outgoing" },
        ],
      },
      inverse: {
        steps: [
          { edge: "WishCandidate.productId", direction: "incoming" },
          { edge: "WishCandidate.wishId", direction: "outgoing" },
        ],
      },
    },
  ],
  search: { enabled: true },
  capabilities: {
    auditable: true,
    images: {
      storage: false,
      displaySources: [
        {
          relationPath: ["candidates"],
          priority: 0,
          ordering: "declared",
          identityEvidence: false,
        },
      ],
      ingress: [
        {
          kind: "existingRelated",
          routeId: "wish-product",
          relationPath: ["candidates"],
        },
      ],
      routing: {
        candidateFields: ["name", "notes"],
        temporalFields: [],
        lifecycleFilters: [{ field: "acquired", equals: false }],
        signals: { ocrFields: ["name", "notes"], classifierLabels: ["wish"] },
        abstention: { minimumScore: 0.78, minimumMargin: 0.16 },
      },
    },
    countable: true,
    softDelete: true,
    delete: { mode: "soft", bulk: true },
    bulkUpdate: null,
    merge: false,
    operationOwners: { delete: "kernel", merge: null },
    mcp: ["get", "list", "search", "create", "update", "delete"],
  },
  extensions: {
    countFilter: null,
    relatednessSignals: null,
    mcpNames: { plural: "wishes" },
    ports: {
      repository: {
        module: "~/server/repo/wish.entity-adapter",
        export: "wishEntityAdapter",
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
