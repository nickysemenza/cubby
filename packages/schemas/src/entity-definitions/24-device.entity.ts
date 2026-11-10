import { attachedImageInputs } from "./image-description-inputs";
import { idField, readOnly, timestampField } from "./field-policy";
import { z } from "zod";
import { dateTime } from "../codec";
import { devicePlatform } from "../device-fields.js";
import {
  deviceShortcode,
  ledgerPartyShortcode,
  productShortcode,
} from "../identifier-fields.js";
import { defineEntity, defineEntityModel } from "./definition.js";

/** @public The shortcode registry generator parses this module's `definition` and `readSchemas`. */
export const { definition, readSchemas } = defineEntityModel({
  key: "device",
  names: { singular: "Device", plural: "Devices" },
  route: {
    basePath: "devices",
    // Capture exists for registration, but devices are not created from the list.
    createOverride: null,
  },
  table: "Device",
  identifiers: { brand: "DeviceId", shortcode: "DEV-" },
  presentation: {
    list: {
      rail: [{ field: "lastSeenAt" }],
    },
    titleField: "name",
    domain: null,
    description: "One install of the native companion app.",
    emptyState: {
      title: "No devices yet",
      description:
        "A device registers itself the first time its companion app connects.",
    },
    icons: { phosphor: "DeviceMobile", sfSymbol: "iphone", emoji: "📱" },
    detail: {
      summary: [
        {
          kind: "records",
          id: "member",
          title: "Member",
          viewKey: "relation:owner",
        },
        {
          kind: "records",
          id: "hardware-product",
          title: "Hardware Product",
          viewKey: "relation:hardware",
        },
        {
          kind: "fields",
          id: "platform-versions",
          title: "Platform & versions",
          fields: ["platform", "osVersion", "appVersion"],
        },
        {
          kind: "fields",
          id: "last-seen",
          title: "Last seen",
          fields: ["lastSeenAt"],
        },
        {
          kind: "fields",
          id: "automatic-work",
          title: "Automatic work",
          fields: ["automaticWork"],
        },
        {
          kind: "fields",
          id: "image-readiness",
          title: "Image work readiness",
          fields: ["updateRequired", "inactive", "appleIntelligenceAvailable"],
        },
      ],
      lead: ["overview"],
      sections: [
        {
          kind: "fields",
          id: "overview",
          title: "Record",
          fields: [
            "installationId",
            "name",
            "platform",
            "appVersion",
            "osVersion",
            "lastSeenAt",
            "automaticWork",
            "remotePaused",
            "ledgerPartyId",
            "productId",
          ],
        },
        {
          kind: "fields",
          id: "coverage",
          title: "Coverage and summaries",
          fields: [
            "appleIntelligenceAvailable",
            "updateRequired",
            "inactive",
            "createdAt",
            "updatedAt",
          ],
        },
      ],
    },
  },
  model: {
    fields: [
      {
        audit: false,
        key: "installationId",
        semanticRole: "externalIdentifier",
        kind: "text",
        control: { kind: "text", placeholder: "Installation identifier" },
        display: { list: false },
        validation: {
          read: z.string().min(1),
          create: z.string().trim().min(1),
          update: null,
        },
      },
      {
        key: "name",
        kind: "text",
        control: { kind: "text", placeholder: "Device name" },
        display: {},
        validation: {
          read: z.string().min(1),
          create: z.string().trim().min(1),
          update: z.string().trim().min(1).optional(),
        },
      },
      {
        audit: false,
        key: "platform",
        kind: "enum",
        control: {
          kind: "select",
          options: [
            {
              value: "ios",
              label: "iOS",
              glyph: { phosphor: "DeviceMobile", sfSymbol: "iphone" },
            },
            {
              value: "macos",
              label: "macOS",
              glyph: { phosphor: "Laptop", sfSymbol: "laptopcomputer" },
            },
          ],
        },
        display: {
          mobile: { slot: "subtitle", priority: 10 },
          columnGroup: "Device",
          optionRole: "category",
          optionColor: "neutral-status",
        },
        validation: {
          read: devicePlatform,
          create: devicePlatform,
          update: null,
        },
      },
      {
        key: "appVersion",
        control: { kind: "text" },
        kind: "text",
        nullable: true,
        display: { list: false },
        validation: {
          read: z.string().nullable(),
          create: z.string().trim().nullable().optional(),
          update: z.string().trim().nullable().optional(),
        },
      },
      {
        key: "osVersion",
        control: { kind: "text" },
        kind: "text",
        nullable: true,
        display: { list: false },
        validation: {
          read: z.string().nullable(),
          create: z.string().trim().nullable().optional(),
          update: z.string().trim().nullable().optional(),
        },
      },
      {
        key: "lastSeenAt",
        control: { kind: "text", placeholder: "ISO date and time" },
        kind: "timestamp",
        nullable: true,
        display: { columnGroup: "Background work", format: "timestamp" },
        validation: {
          read: dateTime.nullable(),
          create: null,
          update: dateTime.nullable().optional(),
        },
      },
      {
        key: "automaticWork",
        kind: "boolean",
        control: { kind: "checkbox" },
        display: { columnGroup: "Background work", columnLabel: "Automatic" },
        validation: {
          read: z.boolean(),
          create: z.boolean().default(true),
          update: z.boolean().optional(),
        },
      },
      {
        key: "remotePaused",
        kind: "boolean",
        control: { kind: "checkbox" },
        display: { columnGroup: "Background work", columnLabel: "Paused" },
        validation: {
          read: z.boolean(),
          create: z.boolean().default(false),
          update: z.boolean().optional(),
        },
      },
      {
        // Written by the companion hello; null until a hello reports it.
        key: "appleIntelligenceAvailable",
        kind: "boolean",
        nullable: true,
        label: "Apple Intelligence",
        display: { columnGroup: "Background work" },
        validation: readOnly(z.boolean().nullable()),
      },
      {
        key: "updateRequired",
        kind: "boolean",
        display: { columnGroup: "Background work", columnLabel: "Update" },
        provenance: {
          kind: "derived",
          sources: [{ label: "App version" }],
        },
        explanation: {
          ruleId: "device.update-required",
          description:
            "The install's app version is older than the oldest build Cubby accepts writes from, so it cannot process images until it updates.",
        },
        validation: readOnly(z.boolean().default(false)),
      },
      {
        key: "inactive",
        kind: "boolean",
        display: { columnGroup: "Background work" },
        provenance: {
          kind: "derived",
          sources: [{ label: "Last seen" }],
        },
        explanation: {
          ruleId: "device.inactive",
          description:
            "Not seen for 7 days, or never. Inactive installs are left out of Apple queue device counts.",
        },
        validation: readOnly(z.boolean().default(false)),
      },
      {
        key: "ledgerPartyId",
        kind: "identifier",
        nullable: true,
        reference: { entity: "ledgerParty" },
        control: { kind: "specialized", renderer: "entity-select" },
        display: {
          mobile: { slot: "meta", priority: 20 },
          columnGroup: "Device",
          labelPath: "ledgerPartyName",
        },
        validation: {
          read: ledgerPartyShortcode.nullable(),
          create: ledgerPartyShortcode.nullable().optional(),
          update: ledgerPartyShortcode.nullable().optional(),
        },
      },
      {
        key: "productId",
        kind: "identifier",
        nullable: true,
        reference: { entity: "product" },
        control: {
          kind: "specialized",
          renderer: "entity-select",
          // The Product link identifies the physical device used for activity attribution.
          suggest: { basis: ["name", "platform"], reviewRequired: true },
        },
        display: { list: false, labelPath: "productName" },
        validation: {
          read: productShortcode.nullable(),
          create: productShortcode.nullable().optional(),
          update: productShortcode.nullable().optional(),
        },
      },
      {
        key: "ledgerPartyName",
        kind: "text",
        nullable: true,
        provenance: {
          kind: "derived",
          sources: [{ label: "Owner" }],
        },
        explanation: {
          ruleId: "device.ledgerPartyName",
          description: "The current name of this device's owner, if set.",
        },
        validation: readOnly(z.string().nullable()),
      },
      {
        key: "productName",
        kind: "text",
        nullable: true,
        provenance: {
          kind: "derived",
          sources: [{ label: "Hardware" }],
        },
        explanation: {
          ruleId: "device.productName",
          description:
            "The current name of this device's linked hardware Product, if set.",
        },
        validation: readOnly(z.string().nullable()),
      },
      idField(deviceShortcode),
      timestampField("createdAt"),
      timestampField("updatedAt"),
      { output: false, key: "shortcode", kind: "text" },
      { output: false, key: "deletedAt", kind: "timestamp", nullable: true },
    ],
    storage: [
      {
        key: "id",
        specialized: "primary-key:DeviceId",
      },
      { key: "shortcode", specialized: "shortcode" },
      "installationId",
      "name",
      { key: "platform", specialized: "enum:platform" },
      "appVersion",
      "osVersion",
      "lastSeenAt",
      { key: "automaticWork", defaultValue: true },
      { key: "remotePaused", defaultValue: false },
      "appleIntelligenceAvailable",
      "ledgerPartyId",
      "productId",
      { key: "createdAt" },
      { key: "updatedAt", specialized: "updated-at" },
      "deletedAt",
    ],

    sort: {
      fields: ["lastSeenAt", "name", "updatedAt"],
    },
    intents: {
      fields: {
        capture: ["installationId", "name", "platform"],
        full: [
          "installationId",
          "name",
          "platform",
          "appVersion",
          "osVersion",
          "lastSeenAt",
          "automaticWork",
          "remotePaused",
          "ledgerPartyId",
          "productId",
        ],
        identity: ["installationId", "name"],
      },
      create: ["capture", "full"],
      update: ["full", "identity"],
    },
  },

  storage: {
    indexes: [
      { on: ["installationId"], unique: true, where: "{deletedAt} IS NULL" },
    ],
    checks: [{ column: "platform" }],
  },
  filters: {
    audit: true,

    descriptors: [
      {
        columnId: "appleIntelligenceAvailable",
        kind: "boolean",
        deriveSchema: true,
        placeholder: "Filter by Apple Intelligence...",
        options: [
          { value: "true", label: "Available" },
          { value: "false", label: "Unavailable" },
        ],
      },
      {
        columnId: "name",
        field: "search",
        urlKey: "q",
        kind: "text",
        placeholder: "Search devices...",
        deriveSchema: true,
        anyOf: ["name"],
      },
      {
        columnId: "installationId",
        kind: "text",
        placeholder: "Filter by installation ID...",
        deriveSchema: true,
        anyOf: ["installationId"],
      },
      {
        columnId: "platform",
        kind: "multiselect",
        placeholder: "Filter by platform...",
        deriveSchema: true,
        schemaFromRead: true,
        options: [
          { value: "ios", label: "iOS" },
          { value: "macos", label: "macOS" },
        ],
      },
      {
        columnId: "automaticWork",
        kind: "boolean",
        placeholder: "Filter by automatic work...",
        deriveSchema: true,
        options: [
          { value: "true", label: "Automatic work on" },
          { value: "false", label: "Automatic work off" },
        ],
      },
      {
        columnId: "remotePaused",
        kind: "boolean",
        placeholder: "Filter by paused state...",
        deriveSchema: true,
        options: [
          { value: "true", label: "Paused" },
          { value: "false", label: "Not paused" },
        ],
      },
      {
        columnId: "ledgerPartyId",
        kind: "idMulti",
        placeholder: "Filter by owner...",
        brandRef: { entity: "ledgerParty" },
        currentMember: true,
        deriveSchema: true,
      },
      {
        columnId: "lastSeenAt",
        label: "Last seen",
        kind: "range",
        deriveSchema: true,
        stored: true,
        wire: {
          kind: "range",
          from: "lastSeenAtFrom",
          to: "lastSeenAtTo",
          presence: "lastSeenAtPresenceFilter",
        },
        placeholder: "Filter by last seen...",
        options: [
          { value: "has", label: "Seen", meta: true },
          { value: "none", label: "(none)", meta: true },
        ],
      },
    ],
  },

  search: false,
  capabilities: {
    images: {
      storage: false,
    },
    countable: false,
    delete: { mode: "soft", bulk: true },
    merge: false,
    dataQuality: {
      inputs: [
        {
          table: "Product",
          match: { id: "id" },
          columns: ["deletedAt", "id"],
          path: [{ table: "Device", from: "productId", to: "id" }],
        },
        ...attachedImageInputs([
          { table: "Product", from: "id", to: "id" },
          { table: "Device", from: "productId", to: "id" },
        ]),
        {
          table: "Product",
          match: { id: "id" },
          columns: ["deletedAt", "brandId"],
          path: [{ table: "Device", from: "productId", to: "id" }],
        },
        {
          table: "Vendor",
          match: { id: "id" },
          columns: ["deletedAt", "id"],
          path: [
            { table: "Product", from: "brandId", to: "id" },
            { table: "Device", from: "productId", to: "id" },
          ],
        },
        ...attachedImageInputs([
          { table: "Vendor", from: "id", to: "id" },
          { table: "Product", from: "brandId", to: "id" },
          { table: "Device", from: "productId", to: "id" },
        ]),
      ],

      checks: [
        {
          id: "device_owner_missing",
          satisfiedLabel: "Owner recorded",
          placement: { field: "ledgerPartyId" },
          facet: "identity",
          label: "Owner",
          message: "No owner is recorded for this device.",
        },
      ],
    },
  },
  extensions: {
    ports: {
      repository: {
        module: "~/server/domains/device/repo/device",
        export: "deviceRepository",
      },
    },
  },
});

export default defineEntity(
  definition,
  (r) => [
    r.field("ledgerPartyId").named("owner", "Owner"),
    r.field("productId").named("hardware", "Hardware"),
  ],
  readSchemas,
);
