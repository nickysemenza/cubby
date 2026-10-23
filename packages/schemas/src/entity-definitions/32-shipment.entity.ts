import { capitalize } from "@cubby/shared/text-case";
import { z } from "zod";
import { shipmentChildren } from "../child-tables/shipment";
import { shortcodeSchema } from "../identifier-fields";
import {
  shipmentExtraTrackingNumbers,
  shipmentPurpose,
} from "../shipment-fields";
import { defineEntity } from "./definition";

export default defineEntity({
  key: "shipment",
  names: { singular: "Shipment", plural: "Shipments" },
  table: "Shipment",
  identifiers: { brand: "ShipmentId", shortcode: "SHIP-" },
  route: { basePath: "shipments" },
  children: shipmentChildren,
  presentation: {
    titleField: "name",
    domain: "finance",
    description: "A package and its retained shipping evidence.",
    emptyState: {
      title: "No shipments yet",
      description: "Record packages through the shipping evidence workflow.",
    },
    icons: { phosphor: "Package", sfSymbol: "shippingbox", emoji: "📦" },
    list: {
      read: {
        media: ["displayImages"],
        relations: ["purchaseName", "carrierName", "vendorId", "vendorName"],
      },
    },
    detail: {
      summary: [
        {
          kind: "records",
          id: "purchase",
          title: "Purchase",
          viewKey: "relation:purchase",
        },
        {
          kind: "fields",
          id: "seller",
          title: "Seller",
          fields: ["vendorName"],
        },
        {
          kind: "records",
          id: "carrier",
          title: "Carrier",
          viewKey: "relation:carrier",
        },
        {
          kind: "fields",
          id: "tracking-references",
          title: "Tracking references",
          fields: ["trackingNumber", "extraTrackingNumbers"],
        },
        {
          kind: "report",
          id: "tracking-observation",
          title: "Tracking observation",
          slot: "shipment.tracking",
        },
      ],

      additionalSections: [
        { kind: "slot", id: "tracking", title: "Tracking evidence" },
      ],
    },
  },
  model: {
    fields: [
      {
        key: "id",
        kind: "identifier",
        display: { list: false },
        validation: {
          read: shortcodeSchema("shipment"),
          create: null,
          update: null,
        },
      },
      {
        key: "name",
        kind: "text",
        display: {},
        validation: { read: z.string().min(1), create: null, update: null },
      },
      {
        key: "purchaseId",
        kind: "identifier",
        nullable: true,
        reference: { entity: "purchase" },
        display: { columnGroup: "Purchase", labelPath: "purchaseName" },
        validation: {
          read: shortcodeSchema("purchase").nullable(),
          create: null,
          update: null,
        },
      },
      {
        key: "vendorId",
        kind: "identifier",
        nullable: true,
        reference: { entity: "vendor" },
        display: { labelPath: "vendorName" },
        validation: {
          read: shortcodeSchema("vendor").nullable(),
          create: null,
          update: null,
        },
      },
      {
        key: "vendorName",
        kind: "text",
        nullable: true,
        validation: { read: z.string().nullable(), create: null, update: null },
      },
      {
        key: "carrierId",
        kind: "identifier",
        nullable: true,
        reference: { entity: "vendor" },
        display: { columnGroup: "Tracking", labelPath: "carrierName" },
        validation: {
          read: shortcodeSchema("vendor").nullable(),
          create: null,
          update: null,
        },
      },
      {
        key: "purchaseAssociationReviewed",
        kind: "boolean",
        display: {},
        validation: { read: z.boolean(), create: null, update: null },
      },
      {
        key: "trackingNumber",
        kind: "text",
        nullable: true,
        display: { columnGroup: "Tracking" },
        validation: { read: z.string().nullable(), create: null, update: null },
      },
      {
        key: "extraTrackingNumbers",
        kind: "json",
        display: {
          list: false,
          detailLabelPath: "extraTrackingNumbers[].trackingNumber",
        },
        validation: {
          read: shipmentExtraTrackingNumbers,
          create: null,
          update: null,
        },
      },
      {
        key: "purpose",
        kind: "enum",
        display: {
          columnGroup: "Purchase",
          optionRole: "category",
          optionColor: "neutral-status",
          optionGlyph: { phosphor: "Package", sfSymbol: "shippingbox" },
        },
        control: {
          kind: "select",
          options: shipmentPurpose.options.map((value) => ({
            value,
            label: capitalize(value),
          })),
        },
        validation: { read: shipmentPurpose, create: null, update: null },
      },
      {
        key: "notes",
        kind: "text",
        nullable: true,
        display: { list: false },
        validation: { read: z.string().nullable(), create: null, update: null },
      },
      {
        key: "purchaseName",
        kind: "text",
        nullable: true,
        provenance: { kind: "derived", sources: [{ label: "Purchase" }] },
        validation: { read: z.string().nullable(), create: null, update: null },
      },
      {
        key: "carrierName",
        kind: "text",
        nullable: true,
        provenance: { kind: "derived", sources: [{ label: "Carrier Vendor" }] },
        validation: { read: z.string().nullable(), create: null, update: null },
      },
      {
        key: "createdAt",
        kind: "timestamp",
        display: { list: false, format: "timestamp" },
        validation: { read: z.date(), create: null, update: null },
      },
      {
        key: "updatedAt",
        kind: "timestamp",
        display: { list: false, format: "timestamp" },
        validation: { read: z.date(), create: null, update: null },
      },
      { key: "deletedAt", kind: "timestamp", nullable: true },
      { key: "shortcode", kind: "text" },
    ],
    storage: [
      { key: "id", specialized: "primary-key:ShipmentId" },
      { key: "shortcode", specialized: "shortcode" },
      "name",
      { key: "purchaseId", reference: "purchase" },
      { key: "purchaseAssociationReviewed", defaultValue: false },
      { key: "carrierId", reference: "vendor" },
      "trackingNumber",
      {
        key: "extraTrackingNumbers",
        defaultOverride: "generated",
        defaultSql: "'[]'::jsonb",
      },
      { key: "purpose", defaultValue: "unknown" },
      "notes",
      "createdAt",
      { key: "updatedAt", specialized: "updated-at" },
      "deletedAt",
    ],
    create: [],
    update: [],
    audit: [
      "name",
      "purchaseId",
      "carrierId",
      "trackingNumber",
      "extraTrackingNumbers",
      "purpose",
      "notes",
    ],
    output: [
      "id",
      "name",
      "purchaseId",
      "purchaseName",
      "vendorId",
      "vendorName",
      "carrierId",
      "carrierName",
      "trackingNumber",
      "extraTrackingNumbers",
      "purpose",
      "notes",
      "createdAt",
      "updatedAt",
    ],
    derived: {
      vendorId: { via: "purchase.vendor" },
    },
    sort: { fields: ["name", "vendorId", "createdAt", "updatedAt", "purpose"] },
  },
  fields: {
    create: null,
    update: null,
    output: { module: "@cubby/schemas/shipment", export: "shipmentOut" },
  },
  storage: {
    indexes: [{ on: ["purchaseId"] }, { on: ["carrierId", "trackingNumber"] }],
    checks: [{ column: "purpose" }],
  },
  filters: {
    audit: true,
    schema: {
      module: "@cubby/schemas/shipment",
      export: "shipmentFilterFields",
    },
    descriptors: [
      {
        columnId: "name",
        field: "search",
        urlKey: "q",
        kind: "text",
        deriveSchema: true,
        anyOf: ["name", "trackingNumber", "notes"],
        placeholder: "Search shipments...",
      },
      {
        columnId: "purchaseId",
        kind: "idMulti",
        brandRef: { entity: "purchase" },
        deriveSchema: true,
        stored: true,
        placeholder: "Filter purchases...",
      },
      {
        columnId: "vendorId",
        derived: "vendorId",
        kind: "idMulti",
        brandRef: { entity: "vendor" },
        deriveSchema: true,
        placeholder: "Filter vendors...",
      },
      {
        columnId: "carrierId",
        kind: "idMulti",
        brandRef: { entity: "vendor" },
        deriveSchema: true,
        stored: true,
        placeholder: "Filter carriers...",
      },
      {
        columnId: "purpose",
        kind: "multiselect",
        deriveSchema: true,
        stored: true,
        schemaFromRead: true,
        options: shipmentPurpose.options.map((value) => ({
          value,
          label: capitalize(value),
        })),
        placeholder: "Filter purpose...",
      },
    ],
  },
  relations: [
    {
      key: "purchase",
      label: "Purchase",
      target: "purchase",
      cardinality: "one",
      provenance: {
        kind: "local-path",
        steps: [{ edge: "Shipment.purchaseId", direction: "outgoing" }],
      },
      inverse: {
        steps: [{ edge: "Shipment.purchaseId", direction: "incoming" }],
      },
    },
    {
      key: "carrier",
      label: "Carrier",
      target: "vendor",
      cardinality: "one",
      provenance: {
        kind: "local-path",
        steps: [{ edge: "Shipment.carrierId", direction: "outgoing" }],
      },
      inverse: {
        steps: [{ edge: "Shipment.carrierId", direction: "incoming" }],
      },
    },
  ],
  search: "lexical",
  capabilities: {
    auditable: true,
    images: {
      storage: false,
      displaySourceOverrides: [
        {
          relationPath: ["purchase"],
        },
        {
          relationPath: ["purchase", "products"],
        },
        {
          relationPath: ["purchase", "vendor"],
        },
        {
          relationPath: ["carrier"],
        },
      ],
    },
    softDelete: true,
    delete: null,
    merge: false,
    lifecycle: "readOnly",
    timeline: "default",
  },
  extensions: {
    ports: {
      repository: {
        module: "~/server/domains/shipment/repo/entity-repository",
        export: "shipmentRepository",
      },
    },
  },
});
