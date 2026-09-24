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
      sectionOverrides: [
        {
          kind: "fields",
          id: "overview",
          title: "Overview",
          placement: "supporting",
          fields: [
            "name",
            "platform",
            "appVersion",
            "osVersion",
            "lastSeenAt",
            "automaticWork",
            "remotePaused",
            "ledgerPartyId",
            "productId",
            "installationId",
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
        kind: "text",
        labelOverride: "Installation ID",
        control: { kind: "text", placeholder: "Installation identifier" },
        display: { detail: true },
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
        display: { list: true, detail: true },
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
            { value: "ios", label: "iOS" },
            { value: "macos", label: "macOS" },
          ],
        },
        display: { list: true, detail: true, width: "sm" },
        validation: {
          read: devicePlatform,
          create: devicePlatform,
          update: null,
        },
      },
      {
        key: "appVersion",
        kind: "text",
        nullable: true,
        labelOverride: "App version",
        display: { detail: true },
        validation: {
          read: z.string().nullable(),
          create: z.string().trim().nullable().optional(),
          update: z.string().trim().nullable().optional(),
        },
      },
      {
        key: "osVersion",
        kind: "text",
        nullable: true,
        labelOverride: "OS version",
        display: { detail: true },
        validation: {
          read: z.string().nullable(),
          create: z.string().trim().nullable().optional(),
          update: z.string().trim().nullable().optional(),
        },
      },
      {
        key: "lastSeenAt",
        kind: "timestamp",
        nullable: true,
        labelOverride: "Last seen",
        display: { list: true, detail: true, format: "timestamp" },
        validation: {
          read: z.date().nullable(),
          create: null,
          update: z.coerce.date().nullable().optional(),
        },
      },
      {
        key: "automaticWork",
        kind: "boolean",
        labelOverride: "Automatic work",
        control: { kind: "checkbox" },
        display: { list: true, detail: true },
        validation: {
          read: z.boolean(),
          create: z.boolean().default(true),
          update: z.boolean().optional(),
        },
      },
      {
        key: "remotePaused",
        kind: "boolean",
        labelOverride: "Remotely paused",
        control: { kind: "checkbox" },
        display: { list: true, detail: true },
        validation: {
          read: z.boolean(),
          create: z.boolean().default(false),
          update: z.boolean().optional(),
        },
      },
      {
        key: "ledgerPartyId",
        kind: "identifier",
        nullable: true,
        labelOverride: "Owner",
        reference: { entity: "ledgerParty" },
        control: { kind: "specialized", renderer: "entity-select" },
        display: {
          list: true,
          detail: true,
          columnIdOverride: "ledgerPartyName",
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
        labelOverride: "Hardware",
        reference: { entity: "product" },
        control: { kind: "specialized", renderer: "entity-select" },
        display: { detail: true, columnIdOverride: "productName" },
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
        display: { detail: true },
        validation: { read: z.date(), create: null, update: null },
      },
      {
        key: "updatedAt",
        kind: "timestamp",
        display: { detail: true },
        validation: { read: z.date(), create: null, update: null },
      },
      { key: "shortcode", kind: "text", readKeyOverride: null },
      {
        key: "deletedAt",
        kind: "timestamp",
        nullable: true,
        readKeyOverride: null,
      },
    ],
    storage: [
      {
        key: "id",
        defaultOverride: "generated",
        specialized: "primary-key:DeviceId",
      },
      { key: "shortcode", specialized: "shortcode" },
      "installationId",
      "name",
      { key: "platform", specialized: "enum:platform" },
      "appVersion",
      "osVersion",
      "lastSeenAt",
      { key: "automaticWork", defaultOverride: "literal", defaultValue: true },
      { key: "remotePaused", defaultOverride: "literal", defaultValue: false },
      { key: "ledgerPartyId", reference: "ledgerParty" },
      { key: "productId", reference: "product" },
      { key: "createdAt", defaultOverride: "now" },
      { key: "updatedAt", defaultOverride: "now", specialized: "updated-at" },
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
    bulk: [],
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
      fields: ["name", "lastSeenAt", "updatedAt"],
      defaultOverride: "lastSeenAt",
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
        stored: { columns: ["name"] },
      },
      {
        columnId: "installationId",
        kind: "text",
        placeholder: "Filter by installation ID...",
        deriveSchema: true,
        stored: true,
      },
      {
        columnId: "platform",
        kind: "multiselect",
        placeholder: "Filter by platform...",
        deriveSchema: true,
        stored: true,
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
        stored: true,
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
        stored: true,
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
        urlOnly: true,
        deriveSchema: true,
        stored: true,
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
  search: { enabled: false },
  capabilities: {
    auditable: true,
    images: {
      storage: false,
    },
    countable: false,
    softDelete: true,
    delete: { mode: "soft", bulk: true },
    bulkUpdate: null,
    merge: false,
    operationOwners: { delete: "kernel", merge: null },
    mcp: ["get", "list", "create", "update", "delete"],
    dataQuality: {
      checks: [
        {
          id: "device_owner_missing",
          facet: "identity",
          weight: 2,
          label: "Owner",
          message: "No owner is recorded for this device.",
        },
        {
          id: "device_stale",
          facet: "content",
          weight: 1,
          label: "Last seen",
          message:
            "This device hasn't checked in within the last 30 days, or has never checked in.",
        },
      ],
    },
  },
  extensions: {
    ports: {
      repository: {
        module: "~/server/repo/device.entity-adapter",
        export: "deviceEntityAdapter",
      },
    },
  },
});
