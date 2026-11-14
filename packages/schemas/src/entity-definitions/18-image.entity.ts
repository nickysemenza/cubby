import { defineEdge } from "./edges";
import { historicalDateRangePresets } from "../date-range";
import { idField, readOnly, timestampField } from "./field-policy";
import { imageReadSchemas } from "../image-processing";
import { imageChildren } from "../child-tables/image.js";
import {
  imageCaptureAttribution,
  imageCaptureLocation,
  imageMetadataOutcome,
  imageProvenanceEvidence,
  imageSourceEvidence,
} from "../image-capture-fields.js";
import { imageSightingOut } from "../image-sighting-fields.js";
import { optionalImageRepresentations } from "../image-summary.js";
import { defineEntity, defineEntityModel } from "./definition.js";
import { labelField } from "./label-field.js";
import { imageShortcode, ledgerPartyShortcode } from "../identifier-fields.js";
import { z } from "zod";
import { dateTime } from "../codec";
export const generatedImageStatusValues = [
  "PENDING",
  "UPLOADED",
  "FAILED",
] as const;
export const generatedImageRenderStatusValues = [
  "unverified",
  "verified",
  "failed",
] as const;
export const generatedImageStorageStatusValues = [
  "unverified",
  "available",
  "missing",
  "metadata_mismatch",
] as const;
const imageSourceValues = ["own", "catalog", "unknown", "screenshot"] as const;
export const { definition, readSchemas } = defineEntityModel(
  {
    key: "image",
    edges: [
      defineEdge({
        key: "ImageProcessingJob.imageId",
        from: "imageJob",
        to: "image",
        cardinality: "one",
        inverse: {
          key: "image.incoming.ImageProcessingJob.imageId",
          from: "image",
          to: "imageJob",
          cardinality: "many",
        },
        storage: {
          kind: "foreign-key",
          column: "ImageProcessingJob.imageId",
          constrained: true,
        },
        ownership: {
          kind: "entity",
          entity: "imageJob",
        },
        fromEnd: {
          role: "reference",
          label: "target",
          description: "The referenced record.",
          liveness: {
            kind: "must-target-live",
          },
        },
        toEnd: {
          role: "metadata",
          label: "image processing jobs",
          description:
            "Durable processing state for this original image; queue delivery is only a wakeup for this record.",
          liveness: {
            kind: "must-target-live",
          },
        },
        policies: {
          from: {
            delete: {
              kind: "unsupported",
              reason: "This operation is not exposed for this endpoint.",
            },
            merge: {
              kind: "unsupported",
              reason: "This operation is not exposed for this endpoint.",
            },
          },
          to: {
            delete: {
              kind: "disposition",
              disposition: {
                code: "deleteRow",
                effect: "hard-delete",
                description:
                  "The original image's durable processing attempts are removed before the original row.",
              },
              handler: {
                module: "~/server/domains/image/repo/image",
                export: "clearImageEdge",
                argument: "ImageProcessingJob.imageId",
              },
              order: 0,
            },
            merge: {
              kind: "unsupported",
              reason: "This operation is not exposed for this endpoint.",
            },
          },
        },
      }),
      defineEdge({
        key: "SourceOrderObservation.primaryDocumentImageId",
        from: "row:SourceOrderObservation",
        to: "image",
        cardinality: "one",
        inverse: {
          key: "image.incoming.SourceOrderObservation.primaryDocumentImageId",
          from: "image",
          to: "row:SourceOrderObservation",
          cardinality: "many",
        },
        storage: {
          kind: "foreign-key",
          column: "SourceOrderObservation.primaryDocumentImageId",
          constrained: true,
        },
        ownership: {
          kind: "excluded",
          reason: "Immutable source extraction history.",
        },
        fromEnd: {
          role: "reference",
          label: "target",
          description: "The referenced record.",
          liveness: {
            kind: "must-target-live",
          },
        },
        toEnd: {
          role: "media",
          label: "observed primary documents",
          description:
            "Optional source media for an immutable extraction; explicit Image deletion clears only this pointer.",
          liveness: {
            kind: "must-target-live",
          },
        },
        policies: {
          from: {
            delete: {
              kind: "unsupported",
              reason: "This operation is not exposed for this endpoint.",
            },
            merge: {
              kind: "unsupported",
              reason: "This operation is not exposed for this endpoint.",
            },
          },
          to: {
            delete: {
              kind: "disposition",
              disposition: {
                code: "clearFk",
                effect: "detach",
                description:
                  "Explicit Image deletion clears optional media only; extraction, bindings, checksum and captured fingerprint remain immutable.",
              },
              handler: {
                module: "~/server/domains/image/repo/image",
                export: "clearImageEdge",
                argument: "SourceOrderObservation.primaryDocumentImageId",
              },
              order: 1,
            },
            merge: {
              kind: "unsupported",
              reason: "This operation is not exposed for this endpoint.",
            },
          },
        },
      }),
      defineEdge({
        key: "SourceOrderObservation.screenshotImageId",
        from: "row:SourceOrderObservation",
        to: "image",
        cardinality: "one",
        inverse: {
          key: "image.incoming.SourceOrderObservation.screenshotImageId",
          from: "image",
          to: "row:SourceOrderObservation",
          cardinality: "many",
        },
        storage: {
          kind: "foreign-key",
          column: "SourceOrderObservation.screenshotImageId",
          constrained: true,
        },
        ownership: {
          kind: "excluded",
          reason: "Immutable source extraction history.",
        },
        fromEnd: {
          role: "reference",
          label: "target",
          description: "The referenced record.",
          liveness: {
            kind: "must-target-live",
          },
        },
        toEnd: {
          role: "media",
          label: "observed screenshots",
          description:
            "Optional source media for an immutable extraction; explicit Image deletion clears only this pointer.",
          liveness: {
            kind: "must-target-live",
          },
        },
        policies: {
          from: {
            delete: {
              kind: "unsupported",
              reason: "This operation is not exposed for this endpoint.",
            },
            merge: {
              kind: "unsupported",
              reason: "This operation is not exposed for this endpoint.",
            },
          },
          to: {
            delete: {
              kind: "disposition",
              disposition: {
                code: "clearFk",
                effect: "detach",
                description:
                  "Explicit Image deletion clears optional media only; extraction, bindings, checksum and captured fingerprint remain immutable.",
              },
              handler: {
                module: "~/server/domains/image/repo/image",
                export: "clearImageEdge",
                argument: "SourceOrderObservation.screenshotImageId",
              },
              order: 2,
            },
            merge: {
              kind: "unsupported",
              reason: "This operation is not exposed for this endpoint.",
            },
          },
        },
      }),
      defineEdge({
        key: "EntityAttachment.imageId",
        from: "row:EntityAttachment",
        to: "image",
        cardinality: "one",
        inverse: {
          key: "image.incoming.EntityAttachment.imageId",
          from: "image",
          to: "row:EntityAttachment",
          cardinality: "many",
        },
        storage: {
          kind: "foreign-key",
          column: "EntityAttachment.imageId",
          constrained: true,
        },
        ownership: {
          kind: "identity",
          column: "EntityAttachment.entityId",
        },
        fromEnd: {
          role: "reference",
          label: "target",
          description: "The referenced record.",
          liveness: {
            kind: "must-target-live",
          },
        },
        toEnd: {
          role: "media",
          label: "attachments",
          description:
            "A file attached to an entity: a gallery photo, a document, a cookbook cover, or a vendor logo. Says nothing about ownership.",
          liveness: {
            kind: "must-target-live",
          },
        },
        policies: {
          from: {
            delete: {
              kind: "unsupported",
              reason: "This operation is not exposed for this endpoint.",
            },
            merge: {
              kind: "unsupported",
              reason: "This operation is not exposed for this endpoint.",
            },
          },
          to: {
            delete: {
              kind: "disposition",
              disposition: {
                code: "deleteRow",
                effect: "hard-delete",
                description:
                  "Every entity's association with the image — gallery photo, document, cookbook cover, or vendor logo — is removed along with the image; the subjects survive.",
              },
              handler: {
                module: "~/server/domains/image/repo/image",
                export: "clearImageEdge",
                argument: "EntityAttachment.imageId",
              },
              order: 3,
            },
            merge: {
              kind: "unsupported",
              reason: "This operation is not exposed for this endpoint.",
            },
          },
        },
      }),
      defineEdge({
        key: "PhotoRunImage.imageId",
        from: "row:PhotoRunImage",
        to: "image",
        cardinality: "one",
        inverse: {
          key: "image.incoming.PhotoRunImage.imageId",
          from: "image",
          to: "row:PhotoRunImage",
          cardinality: "many",
        },
        storage: {
          kind: "foreign-key",
          column: "PhotoRunImage.imageId",
          constrained: true,
        },
        ownership: {
          kind: "column",
          column: "PhotoRunImage.runId",
        },
        fromEnd: {
          role: "reference",
          label: "target",
          description: "The referenced record.",
          liveness: {
            kind: "must-target-live",
          },
        },
        toEnd: {
          role: "history",
          label: "photo import runs",
          description:
            "A Run-owned image work item preserves picker and processing state.",
          liveness: {
            kind: "must-target-live",
          },
        },
        policies: {
          from: {
            delete: {
              kind: "unsupported",
              reason: "This operation is not exposed for this endpoint.",
            },
            merge: {
              kind: "unsupported",
              reason: "This operation is not exposed for this endpoint.",
            },
          },
          to: {
            delete: {
              kind: "disposition",
              disposition: {
                code: "deleteRow",
                effect: "hard-delete",
                description:
                  "A photo-inventory worklist row cannot outlive its image: a target always names an entity, so the link is never cleared.",
              },
              handler: {
                module: "~/server/domains/image/repo/image",
                export: "clearImageEdge",
                argument: "PhotoRunImage.imageId",
              },
              order: 4,
            },
            merge: {
              kind: "unsupported",
              reason: "This operation is not exposed for this endpoint.",
            },
          },
        },
      }),
      defineEdge({
        key: "ImageDerivative.imageId",
        from: "row:ImageDerivative",
        to: "image",
        cardinality: "one",
        inverse: {
          key: "image.incoming.ImageDerivative.imageId",
          from: "image",
          to: "row:ImageDerivative",
          cardinality: "many",
        },
        storage: {
          kind: "foreign-key",
          column: "ImageDerivative.imageId",
          constrained: true,
        },
        ownership: {
          kind: "column",
          column: "ImageDerivative.imageId",
        },
        fromEnd: {
          role: "reference",
          label: "target",
          description: "The referenced record.",
          liveness: {
            kind: "must-target-live",
          },
        },
        toEnd: {
          role: "media",
          label: "image derivatives",
          description:
            "A transparent representation derived from this original image; it is never a gallery attachment of its own.",
          liveness: {
            kind: "must-target-live",
          },
        },
        policies: {
          from: {
            delete: {
              kind: "unsupported",
              reason: "This operation is not exposed for this endpoint.",
            },
            merge: {
              kind: "unsupported",
              reason: "This operation is not exposed for this endpoint.",
            },
          },
          to: {
            delete: {
              kind: "disposition",
              disposition: {
                code: "deleteRow",
                effect: "hard-delete",
                description:
                  "Non-gallery derivative records are removed with their original image.",
              },
              handler: {
                module: "~/server/domains/image/repo/image",
                export: "clearImageEdge",
                argument: "ImageDerivative.imageId",
              },
              order: 5,
            },
            merge: {
              kind: "unsupported",
              reason: "This operation is not exposed for this endpoint.",
            },
          },
        },
      }),
      defineEdge({
        key: "ImportPreparedOrder.primaryDocumentImageId",
        from: "row:ImportPreparedOrder",
        to: "image",
        cardinality: "one",
        inverse: {
          key: "image.incoming.ImportPreparedOrder.primaryDocumentImageId",
          from: "image",
          to: "row:ImportPreparedOrder",
          cardinality: "many",
        },
        storage: {
          kind: "foreign-key",
          column: "ImportPreparedOrder.primaryDocumentImageId",
          constrained: true,
        },
        ownership: {
          kind: "excluded",
          reason:
            "Workflow evidence about entities, not a relationship between them.",
        },
        fromEnd: {
          role: "reference",
          label: "target",
          description: "The referenced record.",
          liveness: {
            kind: "must-target-live",
          },
        },
        toEnd: {
          role: "media",
          label: "prepared primary documents",
          description:
            "The primary source document retained by an immutable prepared import order.",
          liveness: {
            kind: "must-target-live",
          },
        },
        policies: {
          from: {
            delete: {
              kind: "unsupported",
              reason: "This operation is not exposed for this endpoint.",
            },
            merge: {
              kind: "unsupported",
              reason: "This operation is not exposed for this endpoint.",
            },
          },
          to: {
            delete: {
              kind: "disposition",
              disposition: {
                code: "clearFk",
                effect: "detach",
                description:
                  "Prepared import evidence remains while its deleted primary document link is cleared.",
              },
              handler: {
                module: "~/server/domains/image/repo/image",
                export: "clearImageEdge",
                argument: "ImportPreparedOrder.primaryDocumentImageId",
              },
              order: 6,
            },
            merge: {
              kind: "unsupported",
              reason: "This operation is not exposed for this endpoint.",
            },
          },
        },
      }),
      defineEdge({
        key: "ImportPreparedOrder.screenshotImageId",
        from: "row:ImportPreparedOrder",
        to: "image",
        cardinality: "one",
        inverse: {
          key: "image.incoming.ImportPreparedOrder.screenshotImageId",
          from: "image",
          to: "row:ImportPreparedOrder",
          cardinality: "many",
        },
        storage: {
          kind: "foreign-key",
          column: "ImportPreparedOrder.screenshotImageId",
          constrained: true,
        },
        ownership: {
          kind: "excluded",
          reason:
            "Workflow evidence about entities, not a relationship between them.",
        },
        fromEnd: {
          role: "reference",
          label: "target",
          description: "The referenced record.",
          liveness: {
            kind: "must-target-live",
          },
        },
        toEnd: {
          role: "media",
          label: "prepared screenshots",
          description:
            "The browser screenshot retained by an immutable prepared import order.",
          liveness: {
            kind: "must-target-live",
          },
        },
        policies: {
          from: {
            delete: {
              kind: "unsupported",
              reason: "This operation is not exposed for this endpoint.",
            },
            merge: {
              kind: "unsupported",
              reason: "This operation is not exposed for this endpoint.",
            },
          },
          to: {
            delete: {
              kind: "disposition",
              disposition: {
                code: "clearFk",
                effect: "detach",
                description:
                  "Prepared import evidence remains while its deleted screenshot link is cleared.",
              },
              handler: {
                module: "~/server/domains/image/repo/image",
                export: "clearImageEdge",
                argument: "ImportPreparedOrder.screenshotImageId",
              },
              order: 7,
            },
            merge: {
              kind: "unsupported",
              reason: "This operation is not exposed for this endpoint.",
            },
          },
        },
      }),
      defineEdge({
        key: "OrderMailAttachment.imageId",
        from: "row:OrderMailAttachment",
        to: "image",
        cardinality: "one",
        inverse: {
          key: "image.incoming.OrderMailAttachment.imageId",
          from: "image",
          to: "row:OrderMailAttachment",
          cardinality: "many",
        },
        storage: {
          kind: "foreign-key",
          column: "OrderMailAttachment.imageId",
          constrained: true,
        },
        ownership: {
          kind: "excluded",
          reason:
            "Workflow evidence about entities, not a relationship between them.",
        },
        fromEnd: {
          role: "reference",
          label: "target",
          description: "The referenced record.",
          liveness: {
            kind: "must-target-live",
          },
        },
        toEnd: {
          role: "media",
          label: "mail attachments",
          description: "A normalized document captured from an order email.",
          liveness: {
            kind: "must-target-live",
          },
        },
        policies: {
          from: {
            delete: {
              kind: "unsupported",
              reason: "This operation is not exposed for this endpoint.",
            },
            merge: {
              kind: "unsupported",
              reason: "This operation is not exposed for this endpoint.",
            },
          },
          to: {
            delete: {
              kind: "disposition",
              disposition: {
                code: "clearFk",
                effect: "detach",
                description:
                  "The normalized mail attachment remains while its optional stored image is cleared.",
              },
              handler: {
                module: "~/server/domains/image/repo/image",
                export: "clearImageEdge",
                argument: "OrderMailAttachment.imageId",
              },
              order: 8,
            },
            merge: {
              kind: "unsupported",
              reason: "This operation is not exposed for this endpoint.",
            },
          },
        },
      }),
      defineEdge({
        key: "ImageSighting.imageId",
        from: "row:ImageSighting",
        to: "image",
        cardinality: "one",
        inverse: {
          key: "image.incoming.ImageSighting.imageId",
          from: "image",
          to: "row:ImageSighting",
          cardinality: "many",
        },
        storage: {
          kind: "foreign-key",
          column: "ImageSighting.imageId",
          constrained: true,
        },
        ownership: {
          kind: "column",
          column: "ImageSighting.imageId",
        },
        fromEnd: {
          role: "reference",
          label: "target",
          description: "The referenced record.",
          liveness: {
            kind: "must-target-live",
          },
        },
        toEnd: {
          role: "owned-child",
          label: "sightings",
          description:
            "A report of this image appearing in a member's photo library or cloud asset; meaningless without the original image.",
          liveness: {
            kind: "must-target-live",
          },
        },
        policies: {
          from: {
            delete: {
              kind: "unsupported",
              reason: "This operation is not exposed for this endpoint.",
            },
            merge: {
              kind: "unsupported",
              reason: "This operation is not exposed for this endpoint.",
            },
          },
          to: {
            delete: {
              kind: "disposition",
              disposition: {
                code: "deleteRow",
                effect: "hard-delete",
                description:
                  "A sighting cannot outlive the image it reports on.",
              },
              handler: {
                module: "~/server/domains/image/repo/image",
                export: "clearImageEdge",
                argument: "ImageSighting.imageId",
              },
              order: 9,
            },
            merge: {
              kind: "unsupported",
              reason: "This operation is not exposed for this endpoint.",
            },
          },
        },
      }),
    ],

    names: { singular: "Image", plural: "Images" },
    route: {
      listColumns: {
        module: "~/features/image/list-columns",
        export: "imageListOverride",
      },
      basePath: "images",
      // The upload dialog owns this route's create trigger.
      list: null,
    },
    table: "Image",
    children: imageChildren,
    identifiers: { brand: "ImageId", shortcode: "IMG-" },
    presentation: {
      searchFacts: ["capturedAt", "size"],
      titleField: "filename",
      domain: null,
      description: "Images attached to household records.",
      emptyState: {
        title: "No photos yet",
        description:
          "Add photos to attach them to recipes, products, and places.",
      },
      icons: { phosphor: "Image", sfSymbol: "photo", emoji: "🖼️" },
      detail: {
        omitRelations: {
          "sighting-devices":
            "Connected records shows the witnessed reporting devices without a second table.",
          "sighting-members":
            "Connected records distinguishes observers from the Captured by photographer.",
        },
        summary: [
          {
            kind: "report",
            id: "linked-records",
            title: "Linked records",
            slot: "image.associations",
          },
          {
            kind: "fields",
            id: "captured",
            title: "Captured",
            fields: ["capturedAt"],
          },
          {
            kind: "fields",
            id: "file",
            title: "File",
            fields: ["filename", "contentType", "size"],
          },
          {
            kind: "fields",
            id: "dimensions",
            title: "Dimensions",
            fields: ["width", "height"],
          },
          {
            kind: "fields",
            id: "processing",
            title: "Processing",
            fields: ["status", "renderStatus", "storageStatus"],
          },
        ],

        hero: {
          when: { field: "capturedAt", label: "Taken" },
        },
        sections: [
          {
            kind: "fields",
            id: "overview",
            title: "Record",
            fields: [
              "filename",
              "source",
              "sourcePageUrl",
              "sourceAssetUrl",
              "sourceName",
              "useOriginal",
              "capturedAt",
              "capturedByPartyId",
            ],
          },
          {
            kind: "fields",
            id: "coverage",
            title: "Coverage and summaries",
            fields: [
              "url",
              "key",
              "size",
              "contentType",
              "status",
              "width",
              "height",
              "detectedContentType",
              "sha256",
              "renderStatus",
              "storageStatus",
              "verifiedAt",
              "capturedAtOffsetMinutes",
              "captureLocation",
              "capturePlaceName",
              "captureDeviceLabel",
              "captureAttribution",
              "provenanceEvidence",
              "sourceEvidence",
              "sightings",
              "createdAt",
              "updatedAt",
            ],
          },
          { kind: "slot", id: "associations", title: "Used by" },
        ],
      },
      // An uploaded image displays itself; it loads as list media.
      list: {
        rail: [{ field: "size" }],
      },
    },
    model: {
      grouping: ["metadataOutcome"],
      fields: [
        {
          audit: false,
          key: "filename",
          kind: "text",
          control: { kind: "text" },
          display: {},
          validation: {
            read: z.string(),
            create: null,
            update: z.string().trim().min(1).max(255),
          },
        },
        idField(imageShortcode),
        {
          display: { detail: false, list: false },
          key: "representations",
          kind: "json",
          provenance: {
            kind: "derived",
            sources: [{ label: "Original and validated image derivatives" }],
          },
          explanation: {
            ruleId: "image.representations",
            description:
              "The original is preserved. A validated transparent derivative of the current original is preferred unless Use original is selected.",
            resolver: "imageRepresentation",
            sourceDependencies: [
              { path: "representations.original", label: "Original image" },
              {
                path: "representations.transparent",
                label: "Validated transparent derivative",
              },
              {
                path: "representations.preferredKind",
                label: "Selected representation",
              },
              { path: "useOriginal", label: "Use original preference" },
            ],
          },
          validation: readOnly(optionalImageRepresentations),
        },
        {
          key: "url",
          kind: "text",
          display: { columnGroup: "File", listHidden: true },
          provenance: {
            kind: "derived",
            sources: [{ label: "Image storage" }],
          },
          explanation: {
            ruleId: "image.url",
            description:
              "The public image URL is generated from this Image record's current object-storage key.",
            readPath: "url",
            sourceDependencies: [{ path: "key", label: "Image storage key" }],
          },
          validation: readOnly(z.url()),
        },
        {
          key: "key",
          kind: "text",
          display: { columnGroup: "File", listHidden: true },
          validation: readOnly(z.string()),
        },
        {
          key: "size",
          kind: "number",
          display: {
            columnGroup: "File",
            columnBar: true,
            width: "xs",
            format: "bytes",
            mobile: { slot: "trailing", priority: 5 },
          },
          validation: readOnly(z.number().int().positive()),
        },
        {
          key: "contentType",
          kind: "text",
          display: {
            columnGroup: "File",
            width: "sm",
            mobile: { slot: "subtitle", priority: 10 },
          },
          validation: readOnly(z.string()),
        },
        {
          key: "status",
          kind: "enum",
          display: {
            columnGroup: "Processing",
            mobile: { slot: "meta", priority: 20 },
            valueOptions: [
              {
                value: "PENDING",
                label: "Pending",
                color: "neutral-status",
              },
              {
                value: "UPLOADED",
                quiet: true,
                label: "Uploaded",
                color: "positive",
              },
              {
                value: "FAILED",
                label: "Failed",
                color: "destructive",
              },
            ],
            optionRole: "status",
            optionColor: "neutral-status",
          },
          validation: readOnly(z.enum(generatedImageStatusValues)),
        },
        {
          key: "width",
          kind: "number",
          nullable: true,
          display: { columnGroup: "File", listHidden: true },
          validation: readOnly(z.number().int().positive().nullable()),
        },
        {
          key: "height",
          kind: "number",
          nullable: true,
          display: { columnGroup: "File", listHidden: true },
          validation: readOnly(z.number().int().positive().nullable()),
        },
        { output: false, key: "perceptualHash", kind: "text", nullable: true },
        {
          output: false,
          key: "sourceFingerprint",
          kind: "json",
          nullable: true,
        },
        {
          key: "detectedContentType",
          kind: "text",
          nullable: true,
          // Hidden by default: it repeats Type except when sniffing disagrees
          // with the stored content type, which the detail page shows.
          display: { columnGroup: "File", listHidden: true },
          validation: readOnly(z.string().nullable()),
        },
        {
          key: "sha256",
          kind: "text",
          nullable: true,
          display: { columnGroup: "File", listHidden: true },
          validation: readOnly(z.string().nullable()),
        },
        {
          key: "renderStatus",
          kind: "enum",
          nullable: true,
          display: {
            columnGroup: "Processing",
            columnLabel: "Render",
            optionRole: "status",
            optionColor: "neutral-status",
            valueOptions: [
              {
                value: "unverified",
                label: "Unverified",
                color: "neutral-status",
              },
              { value: "verified", label: "Verified", color: "positive" },
              { value: "failed", label: "Failed", color: "destructive" },
            ],
          },
          validation: readOnly(
            z.enum(generatedImageRenderStatusValues).nullable(),
          ),
        },
        {
          key: "storageStatus",
          kind: "enum",
          nullable: true,
          display: {
            columnGroup: "Processing",
            columnLabel: "Storage",
            optionRole: "status",
            optionColor: "neutral-status",
            valueOptions: [
              {
                value: "unverified",
                label: "Unverified",
                color: "neutral-status",
              },
              { value: "available", label: "Available", color: "positive" },
              { value: "missing", label: "Missing", color: "destructive" },
              {
                value: "metadata_mismatch",
                label: "Metadata mismatch",
                color: "destructive",
              },
            ],
          },
          validation: readOnly(
            z.enum(generatedImageStorageStatusValues).nullable(),
          ),
        },
        {
          audit: false,
          key: "source",
          kind: "enum",
          control: {
            kind: "select",
            options: [
              {
                value: "own",
                label: "Own",
              },
              {
                value: "catalog",
                label: "Catalog",
              },
              {
                value: "unknown",
                label: "Unknown",
                color: "neutral-status",
                glyph: {
                  phosphor: "Question",
                  sfSymbol: "questionmark.circle",
                },
              },
              {
                value: "screenshot",
                label: "Screenshot",
              },
            ],
          },
          display: {
            columnGroup: "Provenance",
            optionRole: "category",
            optionColor: "neutral-status",
            optionGlyph: { phosphor: "Image", sfSymbol: "photo" },
          },
          validation: {
            read: z.enum(imageSourceValues),
            create: null,
            update: z.enum(imageSourceValues).optional(),
          },
        },
        {
          audit: false,
          key: "sourcePageUrl",
          control: { kind: "text" },
          kind: "text",
          nullable: true,
          display: { list: false },
          validation: {
            read: z.url().nullable(),
            create: null,
            update: z.url().nullable().optional(),
          },
        },
        {
          audit: false,
          key: "sourceAssetUrl",
          control: { kind: "text" },
          kind: "text",
          nullable: true,
          display: { list: false },
          validation: {
            read: z.url().nullable(),
            create: null,
            update: z.url().nullable().optional(),
          },
        },
        {
          audit: false,
          key: "sourceName",
          control: { kind: "text" },
          kind: "text",
          nullable: true,
          display: { list: false },
          validation: {
            read: z.string().nullable(),
            create: null,
            update: z.string().trim().min(1).max(255).nullable().optional(),
          },
        },
        {
          audit: false,
          key: "useOriginal",
          control: { kind: "checkbox" },
          kind: "boolean",
          display: { columnGroup: "Processing" },
          validation: {
            read: z.boolean(),
            create: null,
            update: z.boolean().optional(),
          },
        },
        {
          key: "verifiedAt",
          kind: "timestamp",
          nullable: true,
          display: { columnGroup: "Processing" },
          validation: readOnly(dateTime.nullable()),
        },
        {
          audit: false,
          key: "capturedAt",
          control: { kind: "text", placeholder: "ISO date and time" },
          kind: "timestamp",
          nullable: true,
          display: { columnGroup: "Provenance", format: "timestamp" },
          validation: {
            read: dateTime.nullable(),
            create: null,
            update: dateTime.nullable().optional(),
          },
        },
        {
          key: "capturedAtOffsetMinutes",
          kind: "number",
          nullable: true,
          display: { list: false },
          validation: readOnly(z.number().int().nullable()),
        },
        {
          key: "captureLocation",
          kind: "json",
          nullable: true,
          // Detail-only by design (no `list: true`) — GPS coordinates never
          // belong in a list column.
          display: {
            list: false,
            renderer: { detail: "image-capture-location" },
          },
          validation: readOnly(imageCaptureLocation.nullable()),
        },
        {
          key: "capturePlaceName",
          kind: "text",
          nullable: true,
          display: { list: false },
          validation: readOnly(z.string().nullable()),
        },
        {
          key: "captureDeviceLabel",
          kind: "text",
          nullable: true,
          display: { list: false },
          validation: readOnly(z.string().nullable()),
        },
        {
          audit: false,
          key: "capturedByPartyId",
          kind: "identifier",
          nullable: true,
          reference: { entity: "ledgerParty" },
          control: { kind: "specialized", renderer: "entity-select" },
          display: { columnGroup: "Provenance", columnLabel: "Captured by" },
          explanation: {
            ruleId: "image.capturedBy",
            description:
              "The capturing member is derived by scoring the image's photo-library sightings, falling back to embedded EXIF evidence when there are none, and can always be set manually.",
            resolver: "imageCapture",
            readPath: "capturedByPartyId",
          },
          validation: {
            read: ledgerPartyShortcode.nullable(),
            create: null,
            update: ledgerPartyShortcode.nullable().optional(),
          },
        },
        {
          display: { detail: false, list: false },
          key: "capturedByName",
          kind: "text",
          nullable: true,
          provenance: {
            kind: "derived",
            sources: [
              { label: "Photo library sightings" },
              { label: "Embedded EXIF" },
              { label: "Manual" },
            ],
          },
          explanation: {
            ruleId: "image.capturedByName",
            description:
              "The current name of the derived capturing member, if set.",
          },
          validation: readOnly(z.string().nullable()),
        },
        {
          key: "captureAttribution",
          kind: "enum",
          display: {
            columnGroup: "Provenance",
            columnLabel: "Attribution",
            optionRole: "status",
            optionColor: "neutral-status",
            valueOptions: [
              { value: "none", label: "None", color: "neutral-status" },
              { value: "derived", label: "Derived", color: "neutral-status" },
              {
                value: "ambiguous",
                label: "Ambiguous",
                stage: "needs_you",
                color: "warning",
              },
              {
                value: "confirmed",
                label: "Confirmed",
                stage: "done",
                color: "positive",
              },
            ],
          },
          validation: readOnly(imageCaptureAttribution),
        },
        {
          key: "provenanceEvidence",
          kind: "json",
          nullable: true,
          display: { list: false, detailLabelPath: "provenanceEvidenceLabel" },
          validation: readOnly(imageProvenanceEvidence.nullable()),
        },
        {
          key: "sourceEvidence",
          kind: "json",
          nullable: true,
          display: { list: false, detailLabelPath: "sourceEvidence.model" },
          validation: readOnly(imageSourceEvidence.nullable()),
        },
        {
          // Detail-only: the live rows of the `ImageSighting` child table
          // (not an entity), each naming its owner and reporting device.
          key: "sightings",
          kind: "json",
          provenance: {
            kind: "derived",
            sources: [{ label: "Photo library sightings" }],
          },
          display: { list: false, renderer: { detail: "image-sightings" } },
          validation: readOnly(z.array(imageSightingOut).optional()),
        },
        {
          output: false,
          key: "metadataRevision",
          kind: "number",
          nullable: true,
        },
        {
          output: false,
          key: "embeddedMetadata",
          kind: "json",
          nullable: true,
        },
        {
          output: false,
          // Terminal EXIF/GPS outcome: a row that can never extract leaves the
          // `metadataRevision` backlog with its raw error instead of pinning it.
          key: "metadataOutcome",
          kind: "enum",
          nullable: true,
        },
        { output: false, key: "metadataError", kind: "text", nullable: true },
        timestampField("createdAt"),
        timestampField("updatedAt"),
        {
          output: false,
          key: "images",
          kind: "json",
          label: "Image",
          // A row IS an image: the thumbnail renders once its file is uploaded.
          display: {
            standard: "image",
            listOrder: 0,
            renderer: { list: "uploaded-image" },
            readFields: ["url", "status", "filename"],
          },
          provenance: {
            kind: "derived",
            sources: [{ label: "Image storage" }],
          },
          validation: readOnly(z.array(z.unknown())),
        },
        { output: false, key: "shortcode", kind: "text" },
        { output: false, key: "deletedAt", kind: "timestamp", nullable: true },
        {
          output: false,
          key: "confirmedDescription",
          kind: "text",
          nullable: true,
        },
        {
          output: false,
          key: "descriptionContentHash",
          kind: "text",
          nullable: true,
        },
        {
          output: false,
          key: "descriptionConfirmedAt",
          kind: "timestamp",
          nullable: true,
        },
        {
          output: false,
          key: "descriptionConfirmationOwner",
          kind: "json",
          nullable: true,
        },
        // Server-composed text for the evidence above (`display.detailLabelPath`).
        labelField("provenanceEvidenceLabel", "Image provenance evidence"),
      ],
      storage: [
        {
          key: "id",
          specialized: "primary-key:ImageId",
        },
        { key: "shortcode", specialized: "shortcode" },
        "key",
        "filename",
        "size",
        "contentType",
        {
          key: "status",
          defaultValue: "'PENDING'",
          specialized: "enum:ImageStatus",
        },
        "width",
        "height",
        "perceptualHash",
        {
          key: "sourceFingerprint",
          type: {
            module: "@cubby/schemas/image",
            export: "ImageSourceFingerprint",
          },
        },
        "detectedContentType",
        "sha256",
        "confirmedDescription",
        "descriptionContentHash",
        "descriptionConfirmedAt",
        {
          key: "descriptionConfirmationOwner",
          type: {
            module: "@cubby/schemas/image-processing",
            export: "ImageDescriptionConfirmationOwner",
          },
        },
        { key: "renderStatus", specialized: "enum:ImageRenderStatus" },
        { key: "storageStatus", specialized: "enum:ImageStorageStatus" },
        {
          key: "source",
          specialized: "enum:source",
          defaultValue: "unknown",
        },
        "sourcePageUrl",
        "sourceAssetUrl",
        "sourceName",
        { key: "useOriginal", defaultValue: false },
        "verifiedAt",
        "capturedAt",
        "capturedAtOffsetMinutes",
        {
          key: "captureLocation",
          specialized: "json:captureLocation",
          type: {
            module: "@cubby/schemas/image-capture-fields",
            export: "ImageCaptureLocation",
          },
        },
        "capturePlaceName",
        "captureDeviceLabel",
        "capturedByPartyId",
        {
          key: "captureAttribution",
          specialized: "enum:captureAttribution",
          defaultValue: "none",
        },
        {
          key: "provenanceEvidence",
          specialized: "json:provenanceEvidence",
          type: {
            module: "@cubby/schemas/image-capture-fields",
            export: "ImageProvenanceEvidence",
          },
        },
        { key: "sourceEvidence", specialized: "json:sourceEvidence" },
        "metadataRevision",
        {
          key: "embeddedMetadata",
          specialized: "json:embeddedMetadata",
          type: {
            module: "@cubby/schemas/image",
            export: "StoredImageEmbeddedMetadata",
          },
        },
        {
          key: "metadataOutcome",
          specialized: "enum:ImageMetadataOutcome",
          enum: { values: ["original_missing", "extraction_failed"] },
        },
        "metadataError",
        { key: "createdAt" },
        { key: "updatedAt", specialized: "updated-at" },
        "deletedAt",
      ],

      rows: {
        importTargets: {
          label: "Import targets",
          path: [{ edge: "PhotoRunImage.imageId", direction: "incoming" }],
        },
      },
      derived: {
        // Referenced by a live owner (an attachment, an order document).
        referenced: { type: "boolean" },
        processingIssue: { type: "enum", options: ["failed", "review_needed"] },
        uploadedAgeHours: { type: "number" },
        // Both match on the same import-run target row.
        runId: { via: "importTargets.run" },
        targetState: { via: "importTargets.state" },
      },
      sort: {
        fields: ["createdAt", "updatedAt", "filename", "size", "status"],
      },
    },
    fields: {
      create: null,
      update: { module: "@cubby/schemas/image", export: "imageUpdateInput" },
    },
    storage: {
      indexes: [
        { on: ["key"], unique: true, where: "{deletedAt} IS NULL" },
        { on: ["createdAt"] },
        { on: ["status"] },
      ],
      checks: [
        { column: "status" },
        { column: "renderStatus" },
        { column: "storageStatus" },
        { column: "metadataOutcome", values: imageMetadataOutcome.options },
        {
          name: "Image_perceptualHash_format_check",
          sql: "{perceptualHash} IS NULL OR {perceptualHash} ~ '^[0-9a-f]{16}$'",
        },
      ],
      relations: { attachments: { many: "entityAttachment" } },
    },
    filters: {
      schema: { module: "@cubby/schemas/image", export: "imageFilterFields" },
      descriptors: [
        {
          columnId: "metadataOutcome",
          kind: "multiselect",
          deriveSchema: true,
          placeholder: "Filter by metadata outcome...",
          schemaRef: {
            module: "@cubby/schemas/image-capture-fields",
            export: "imageMetadataOutcome",
          },
          options: [
            { value: "original_missing", label: "Original missing" },
            { value: "extraction_failed", label: "Extraction failed" },
          ],
        },
        {
          columnId: "renderStatus",
          kind: "multiselect",
          deriveSchema: true,
          placeholder: "Filter by render status...",
          options: [
            { value: "unverified", label: "Unverified" },
            { value: "verified", label: "Verified" },
            { value: "failed", label: "Failed" },
          ],
        },
        {
          columnId: "storageStatus",
          kind: "multiselect",
          deriveSchema: true,
          placeholder: "Filter by storage status...",
          options: [
            { value: "unverified", label: "Unverified" },
            { value: "available", label: "Available" },
            { value: "missing", label: "Missing" },
            { value: "metadata_mismatch", label: "Metadata mismatch" },
          ],
        },
        {
          columnId: "useOriginal",
          kind: "boolean",
          deriveSchema: true,
          placeholder: "Filter by original use...",
          options: [
            { value: "true", label: "Uses original" },
            { value: "false", label: "Uses processed" },
          ],
        },
        {
          columnId: "verifiedAt",
          label: "Verified at",
          kind: "range",
          deriveSchema: true,
          stored: true,
          range: { kind: "date" },
          wire: {
            kind: "range",
            from: "verifiedAtFrom",
            to: "verifiedAtTo",
            presence: "verifiedAtPresenceFilter",
          },
          placeholder: "Filter by verified at...",
          options: [
            { value: "has", label: "Has date", meta: true },
            { value: "none", label: "(none)", meta: true },
          ],
        },
        {
          columnId: "filename",
          field: "nameFilter",
          kind: "text",
          placeholder: "Filter by filename...",
          deriveSchema: true,
          anyOf: ["filename"],
          schemaDescription: "Filter by filename (substring)",
        },
        {
          columnId: "status",
          kind: "multiselect",
          placeholder: "Filter by upload status...",
          deriveSchema: true,
          schemaFromRead: true,
          schemaDescription: "Filter by upload status",
          options: [
            { value: "PENDING", label: "Pending", color: "var(--slate)" },
            { value: "UPLOADED", label: "Uploaded", color: "var(--positive)" },
            { value: "FAILED", label: "Failed", color: "var(--destructive)" },
          ],
        },
        {
          columnId: "processingIssue",
          field: "processingIssue",
          kind: "multiselect",
          placeholder: "Filter processing issues...",
          options: [
            { value: "failed", label: "Failed", color: "var(--destructive)" },
            {
              value: "review_needed",
              label: "Needs review",
              color: "var(--warning)",
            },
          ],
        },
        {
          columnId: "entity",
          field: "referencePresenceFilter",
          kind: "presence",
          derived: "referenced",
          placeholder: "Filter references...",
          options: [
            { value: "has", label: "Has reference", meta: true },
            { value: "none", label: "(none)", meta: true },
          ],
        },
        {
          columnId: "createdAt",
          kind: "range",
          placeholder: "Filter by created date...",
          options: [...historicalDateRangePresets],
          expandRef: {
            module: "~/entity/filter-behavior",
            export: "resolveCreatedDate",
          },
          wire: { kind: "range", from: "createdFrom", to: "createdTo" },
        },
        {
          columnId: "updatedAt",
          kind: "range",
          placeholder: "Filter by updated date...",
          options: [...historicalDateRangePresets],
          expandRef: {
            module: "~/entity/filter-behavior",
            export: "resolveUpdatedDate",
          },
          wire: { kind: "range", from: "updatedFrom", to: "updatedTo" },
        },
        {
          columnId: "runId",
          kind: "idMulti",
          placeholder: "Filter by import run...",
          brandRef: { entity: "run" },
        },
        {
          columnId: "targetState",
          kind: "multiselect",
          placeholder: "Filter by import-run target state...",
          options: [
            { value: "pending", label: "Pending", color: "var(--slate)" },
            { value: "prepared", label: "Prepared", color: "var(--info)" },
            {
              value: "completed",
              label: "Completed",
              color: "var(--positive)",
            },
            { value: "skipped", label: "Skipped", color: "var(--slate)" },
            {
              value: "unresolved",
              label: "Unresolved",
              color: "var(--warning)",
            },
            {
              value: "needs_evidence",
              label: "Needs evidence",
              color: "var(--warning)",
            },
            {
              value: "unavailable",
              label: "Unavailable",
              color: "var(--destructive)",
            },
          ],
        },
        {
          columnId: "source",
          kind: "multiselect",
          placeholder: "Filter by source...",
          deriveSchema: true,
          schemaFromRead: true,
          options: [
            { value: "own", label: "Own" },
            { value: "catalog", label: "Catalog" },
            { value: "unknown", label: "Unknown" },
            { value: "screenshot", label: "Screenshot" },
          ],
        },
        {
          columnId: "captureAttribution",
          kind: "multiselect",
          placeholder: "Filter by capture attribution...",
          deriveSchema: true,
          schemaFromRead: true,
          options: [
            { value: "none", label: "None" },
            { value: "derived", label: "Derived" },
            { value: "ambiguous", label: "Ambiguous" },
            { value: "confirmed", label: "Confirmed" },
          ],
        },
        {
          columnId: "capturedAt",
          kind: "range",
          placeholder: "Filter by captured date...",
          deriveSchema: true,
          stored: true,
          range: { kind: "date" },
          options: [...historicalDateRangePresets],
        },
        {
          columnId: "capturedByPartyId",
          kind: "idMulti",
          placeholder: "Filter by captured by...",
          brandRef: { entity: "ledgerParty" },
          currentMember: true,
          deriveSchema: true,
        },
        {
          columnId: "uploadedAgeHours",
          kind: "range",
          placeholder: "Filter by upload age...",
          deriveSchema: true,
          derived: true,
          range: {
            kind: "number",
            nonnegative: true,
            describe: {
              lower: "Only images uploaded at least this many hours ago.",
              upper: "Only images uploaded at most this many hours ago.",
            },
          },
        },
      ],
    },

    // Image filenames and the current preferred description/correction are
    // searchable. The shared search document loader adds only direct owners.
    search: {
      mode: "semantic",
      inputs: [
        {
          table: "AiAnalysis",
          match: { entityId: "id" },
          where: { entityKind: "image", feature: "image-description" },
        },
      ],
    },
    capabilities: {
      auditable: false,
      images: { storage: false },
      delete: { mode: "hard", bulk: true },
      merge: false,
      dataQuality: {
        // Rows the stored evaluator reads beyond its own row (ADR 0021).
        inputs: [
          {
            table: "ImageSighting",
            match: { imageId: "id" },
            columns: ["imageId"],
          },
          { table: "EntityAttachment", match: { imageId: "id" } },
        ],
        checks: [
          {
            id: "image_provenance_unknown",
            satisfiedLabel: "Source recorded",
            placement: { field: "source" },
            facet: "provenance",
            label: "Source",
            message: "This image's origin is unknown.",
          },
          {
            id: "image_capture_attribution",
            satisfiedLabel: "Capture attributed",
            placement: { field: "captureAttribution" },
            facet: "provenance",
            kind: "defect",
            label: "Capture attribution",
            message:
              "Multiple household members could be the photographer; confirm who captured this.",
          },
          {
            id: "image_capture_date",
            satisfiedLabel: "Capture date recorded",
            placement: { field: "capturedAt" },
            facet: "content",
            label: "Capture date",
            message: "No capture date is recorded for this image.",
          },
          {
            id: "image_dimensions",
            satisfiedLabel: "Dimensions recorded",
            placement: { field: "width" },
            facet: "integrity",
            label: "Dimensions",
            message: "Raster image width or height is missing or not positive.",
          },
          {
            id: "image_asset_unusable",
            satisfiedLabel: "File usable",
            placement: { field: "storageStatus" },
            facet: "integrity",
            kind: "defect",
            label: "Unusable file",
            message:
              "The stored file is missing, mismatched, or failed to render.",
          },
          {
            id: "image_sighting_missing",
            satisfiedLabel: "Sightings recorded",
            placement: { field: "sightings" },
            facet: "provenance",
            label: "Sightings",
            message:
              "No live photo-library sighting is recorded for this own-sourced image.",
          },
        ],
      },
    },
    extensions: {
      relatednessSignals: [
        { kind: "semantic", label: "Similar meaning", weight: 1, limit: 8 },
      ],
      ports: {
        reports: {
          module: "~/server/domains/image/repo/report-bindings",
          export: "reportBindings",
        },
        repository: {
          module: "~/server/domains/image/repo/image.repository",
          export: "imageRepository",
        },
      },
    },
  },
  imageReadSchemas,
);

export default defineEntity(
  definition,
  (r) => ({
    edges: [
      r.declare(
        r
          .path("device", "many", [
            { edge: "ImageSighting.imageId", direction: "incoming" },
            { edge: "ImageSighting.deviceId", direction: "outgoing" },
          ])
          .named("sighting-devices", "Sighting devices"),
        "device.image.sighting-devices",
      ),
      r.declare(
        r
          .path("ledgerParty", "many", [
            { edge: "ImageSighting.imageId", direction: "incoming" },
            { edge: "ImageSighting.ledgerPartyId", direction: "outgoing" },
          ])
          .named("sighting-members", "Observed by"),
        "ledgerParty.image.sighting-members",
      ),
      r.declare(
        r.field("capturedByPartyId").named("captured-by", "Captured by"),
        "ledgerParty.images",
      ),
    ],
  }),
  readSchemas,
);
