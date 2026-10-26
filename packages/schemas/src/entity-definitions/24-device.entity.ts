import { z } from "zod";
import { devicePlatform } from "../device-fields.js";
import {
  deviceShortcode,
  ledgerPartyShortcode,
  productShortcode,
} from "../identifier-fields.js";
import { defineEntity } from "./definition.js";

export default defineEntity({
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
    list: {},
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
          read: z.date().nullable(),
          create: null,
          update: z.coerce.date().nullable().optional(),
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
        labelOverride: "Apple Intelligence",
        display: { columnGroup: "Background work" },
        validation: {
          read: z.boolean().nullable(),
          create: null,
          update: null,
        },
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
        validation: {
          read: z.boolean().default(false),
          create: null,
          update: null,
        },
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
        validation: {
          read: z.boolean().default(false),
          create: null,
          update: null,
        },
      },
      {
        key: "ledgerPartyId",
        kind: "identifier",
        nullable: true,
        reference: { entity: "ledgerParty" },
        control: { kind: "specialized", renderer: "entity-select" },
        display: { columnGroup: "Device", labelPath: "ledgerPartyName" },
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
        validation: { read: z.string().nullable(), create: null, update: null },
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
        validation: { read: z.string().nullable(), create: null, update: null },
      },
      {
        display: { detail: false, list: false },
        key: "id",
        kind: "identifier",
        validation: {
          read: deviceShortcode,
          create: null,
          update: null,
        },
      },
      {
        key: "createdAt",
        kind: "timestamp",
        display: { list: false },
        validation: { read: z.date(), create: null, update: null },
      },
      {
        key: "updatedAt",
        kind: "timestamp",
        display: { list: false },
        validation: { read: z.date(), create: null, update: null },
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
      { key: "ledgerPartyId", reference: "ledgerParty" },
      { key: "productId", reference: "product" },
      { key: "createdAt" },
      { key: "updatedAt", specialized: "updated-at" },
      "deletedAt",
    ],
    create: [
      "installationId",
      "name",
      "platform",
      "appVersion",
      "osVersion",
      "automaticWork",
      "remotePaused",
      "ledgerPartyId",
      "productId",
    ],
    update: [
      "name",
      "appVersion",
      "osVersion",
      "lastSeenAt",
      "automaticWork",
      "remotePaused",
      "ledgerPartyId",
      "productId",
    ],
    audit: [
      "name",
      "appVersion",
      "osVersion",
      "lastSeenAt",
      "automaticWork",
      "remotePaused",
      "ledgerPartyId",
      "productId",
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
    output: [
      "id",
      "installationId",
      "name",
      "platform",
      "appVersion",
      "osVersion",
      "lastSeenAt",
      "automaticWork",
      "remotePaused",
      "appleIntelligenceAvailable",
      "updateRequired",
      "inactive",
      "ledgerPartyId",
      "productId",
      "ledgerPartyName",
      "productName",
      "createdAt",
      "updatedAt",
    ],
  },
  fields: {
    create: {
      module: "@cubby/schemas/device",
      export: "deviceCreateInput",
    },
    update: {
      module: "@cubby/schemas/device",
      export: "deviceUpdateData",
    },
    output: {
      module: "@cubby/schemas/device",
      export: "deviceOut",
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
    schema: {
      module: "@cubby/schemas/device",
      export: "deviceFilterFields",
    },
    descriptors: [
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
    ],
  },
  relations: [
    {
      key: "owner",
      label: "Owner",
      target: "ledgerParty",
      cardinality: "one",
      provenance: {
        kind: "local-path",
        steps: [{ edge: "Device.ledgerPartyId", direction: "outgoing" }],
      },
      inverse: {
        steps: [{ edge: "Device.ledgerPartyId", direction: "incoming" }],
      },
    },
    {
      key: "hardware",
      label: "Hardware",
      target: "product",
      cardinality: "one",
      provenance: {
        kind: "local-path",
        steps: [{ edge: "Device.productId", direction: "outgoing" }],
      },
      inverse: {
        steps: [{ edge: "Device.productId", direction: "incoming" }],
      },
    },
  ],
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
        {
          table: "EntityAttachment",
          match: { entityId: "id" },
          columns: ["deletedAt", "imageId", "purpose", "role"],
          path: [
            { table: "Product", from: "id", to: "id" },
            { table: "Device", from: "productId", to: "id" },
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
            { table: "Device", from: "productId", to: "id" },
          ],
        },
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
        {
          table: "EntityAttachment",
          match: { entityId: "id" },
          columns: ["deletedAt", "imageId", "purpose", "role"],
          path: [
            { table: "Vendor", from: "id", to: "id" },
            { table: "Product", from: "brandId", to: "id" },
            { table: "Device", from: "productId", to: "id" },
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
            { table: "Device", from: "productId", to: "id" },
          ],
        },
      ],

      checks: [
        {
          id: "device_owner_missing",
          satisfiedLabel: "Owner recorded",
          placement: { field: "ledgerPartyId" },
          facet: "identity",
          weight: 2,
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
