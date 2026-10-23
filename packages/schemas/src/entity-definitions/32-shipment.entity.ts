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
        quality: ["dataQuality"],
        derived: [
          "firstEventDate",
          "lastEventDate",
          "eventSpanHours",
          "eventSpanLabel",
          "eventCount",
        ],
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
          kind: "fields",
          id: "event-summary",
          title: "Events",
          fields: [
            "firstEventDate",
            "lastEventDate",
            "eventSpanHours",
            "eventCount",
          ],
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
        validation: {
          read: shipmentPurpose,
          create: null,
          update: shipmentPurpose.optional(),
        },
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
        key: "firstEventDate",
        kind: "date",
        nullable: true,
        labelOverride: "First event",
        display: { columnGroup: "Events", format: "plainDate" },
        provenance: {
          kind: "derived",
          sources: [{ label: "Tracking events" }],
        },
        validation: { read: z.string().nullable(), create: null, update: null },
      },
      {
        key: "lastEventDate",
        kind: "date",
        nullable: true,
        labelOverride: "Last event",
        display: { columnGroup: "Events", format: "plainDate" },
        provenance: {
          kind: "derived",
          sources: [{ label: "Tracking events" }],
        },
        validation: { read: z.string().nullable(), create: null, update: null },
      },
      {
        key: "eventSpanHours",
        kind: "number",
        nullable: true,
        labelOverride: "Event span",
        display: {
          columnGroup: "Events",
          labelPath: "eventSpanLabel",
          detailLabelPath: "eventSpanLabel",
        },
        provenance: {
          kind: "derived",
          sources: [{ label: "Tracking events" }],
        },
        validation: {
          read: z.number().nonnegative().nullable(),
          create: null,
          update: null,
        },
      },
      {
        key: "eventSpanLabel",
        kind: "text",
        nullable: true,
        validation: { read: z.string().nullable(), create: null, update: null },
      },
      {
        key: "eventCount",
        kind: "number",
        labelOverride: "Events",
        display: { columnGroup: "Events", format: "count" },
        provenance: {
          kind: "derived",
          sources: [{ label: "Tracking events" }],
        },
        validation: {
          read: z.number().int().nonnegative(),
          create: null,
          update: null,
        },
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
    update: ["purpose"],
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
      "firstEventDate",
      "lastEventDate",
      "eventSpanHours",
      "eventSpanLabel",
      "eventCount",
      "createdAt",
      "updatedAt",
    ],
    derived: {
      vendorId: { via: "purchase.vendor" },
      firstEventDate: { type: "number" },
      lastEventDate: { type: "number" },
      eventSpanHours: { type: "number" },
      eventCount: { type: "number" },
    },
    sort: {
      fields: [
        "name",
        "vendorId",
        "createdAt",
        "updatedAt",
        "purpose",
        "firstEventDate",
        "lastEventDate",
        "eventSpanHours",
        "eventCount",
      ],
    },
  },
  fields: {
    create: null,
    update: { module: "@cubby/schemas/shipment", export: "shipmentUpdateData" },
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
    lifecycle: "mutable",
    timeline: "default",
    dataQuality: {
      displayImage: false,
      checks: [
        {
          id: "shipment_events",
          facet: "provenance",
          weight: 10,
          scoreCap: 25,
          label: "Limited event history",
          satisfiedLabel: "Multiple distinct events",
          message:
            "Fewer than two distinct current tracking events are retained.",
          placement: { field: "eventCount" },
        },
        {
          id: "shipment_shipped",
          facet: "provenance",
          weight: 30,
          label: "Shipment not evidenced",
          satisfiedLabel: "Shipment evidenced",
          message:
            "No carrier possession or movement event is retained. A label alone does not establish shipment.",
          placement: { section: "tracking" },
        },
        {
          id: "shipment_delivered",
          facet: "provenance",
          weight: 30,
          label: "Delivery not yet evidenced",
          satisfiedLabel: "Delivery evidenced",
          message: "No explicit delivered event is retained.",
          placement: { section: "tracking" },
        },
        {
          id: "shipment_span",
          facet: "provenance",
          weight: 10,
          label: "Limited event span",
          satisfiedLabel: "Event span exceeds one day",
          message:
            "The dated event span must be strictly greater than one day.",
          placement: { field: "eventSpanHours" },
        },
        {
          id: "shipment_dates",
          facet: "provenance",
          weight: 10,
          label: "Missing milestone dates",
          satisfiedLabel: "Milestone dates recorded",
          message:
            "Shipment and delivery evidence need known dates or exact timestamps.",
          placement: { section: "tracking" },
        },
        {
          id: "shipment_chronology",
          facet: "integrity",
          weight: 10,
          kind: "defect",
          label: "Conflicting shipment chronology",
          satisfiedLabel: "Consistent shipment chronology",
          message:
            "Exact delivery reports conflict or exact shipment milestones are out of order.",
          placement: { section: "tracking" },
        },
      ],
    },
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
