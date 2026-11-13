import { defineEdge } from "./edges";
import { idField, timestampField } from "./field-policy";
import { defineEntity, defineEntityModel } from "./definition.js";
import { selectControlOptions } from "./select-control-options.js";
import { ledgerPartyShortcode } from "../identifier-fields.js";
import { ledgerPartyKind } from "@cubby/schemas/ledger-party-fields";
import { z } from "zod";
/** @public The shortcode registry generator parses this module's `definition` and `readSchemas`. */
export const { definition, readSchemas } = defineEntityModel({
  key: "ledgerParty",
  edges: [
    defineEdge({
      key: "InventoryEntry.ownerLedgerPartyId",
      from: "inventory",
      to: "ledgerParty",
      cardinality: "one",
      inverse: {
        key: "ledgerParty.incoming.InventoryEntry.ownerLedgerPartyId",
        from: "ledgerParty",
        to: "inventory",
        cardinality: "many",
      },
      storage: {
        kind: "foreign-key",
        column: "InventoryEntry.ownerLedgerPartyId",
        constrained: true,
      },
      ownership: {
        kind: "entity",
        entity: "inventory",
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
        role: "reference",
        label: "owned inventory entries",
        description:
          "An explicit member or guest owner pinned on a current inventory slot.",
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
              code: "block-inventory-owners",
              effect: "block",
              description:
                "Explicit inventory ownership retains its individual owner.",
            },
            handler: null,
            order: 0,
          },
          merge: {
            kind: "disposition",
            disposition: {
              code: "merge-inventory-owners",
              effect: "move-dedupe",
              description:
                "Explicitly owned inventory moves to the surviving person and folds only when the complete raw slot and unit agree.",
            },
            handler: {
              module: "~/server/domains/ledger-party/repo/ledger-party",
              export: "ledgerPartyMergeEdgeHandlers",
              member: "moveInventoryOwnership",
            },
            order: 0,
          },
        },
      },
    }),
    defineEdge({
      key: "LedgerTransfer.fromPartyId",
      from: "ledgerTransfer",
      to: "ledgerParty",
      cardinality: "one",
      inverse: {
        key: "ledgerParty.incoming.LedgerTransfer.fromPartyId",
        from: "ledgerParty",
        to: "ledgerTransfer",
        cardinality: "many",
      },
      storage: {
        kind: "foreign-key",
        column: "LedgerTransfer.fromPartyId",
        constrained: true,
      },
      ownership: {
        kind: "entity",
        entity: "ledgerTransfer",
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
        role: "ledger",
        label: "outgoing transfers",
        description: "A transfer source endpoint.",
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
              code: "block-outgoing-transfers",
              effect: "block",
              description: "Live transfers retain their source party.",
            },
            handler: null,
            order: 1,
          },
          merge: {
            kind: "disposition",
            disposition: {
              code: "repoint-outgoing-transfers",
              effect: "repoint",
              description: "Transfer source endpoints move to the survivor.",
            },
            handler: null,
            order: 1,
          },
        },
      },
    }),
    defineEdge({
      key: "LedgerTransfer.toPartyId",
      from: "ledgerTransfer",
      to: "ledgerParty",
      cardinality: "one",
      inverse: {
        key: "ledgerParty.incoming.LedgerTransfer.toPartyId",
        from: "ledgerParty",
        to: "ledgerTransfer",
        cardinality: "many",
      },
      storage: {
        kind: "foreign-key",
        column: "LedgerTransfer.toPartyId",
        constrained: true,
      },
      ownership: {
        kind: "entity",
        entity: "ledgerTransfer",
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
        role: "ledger",
        label: "incoming transfers",
        description: "A transfer target endpoint.",
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
              code: "block-incoming-transfers",
              effect: "block",
              description: "Live transfers retain their target party.",
            },
            handler: null,
            order: 2,
          },
          merge: {
            kind: "disposition",
            disposition: {
              code: "repoint-incoming-transfers",
              effect: "repoint",
              description: "Transfer target endpoints move to the survivor.",
            },
            handler: null,
            order: 2,
          },
        },
      },
    }),
    defineEdge({
      key: "Project.assigneeId",
      from: "project",
      to: "ledgerParty",
      cardinality: "one",
      inverse: {
        key: "ledgerParty.incoming.Project.assigneeId",
        from: "ledgerParty",
        to: "project",
        cardinality: "many",
      },
      storage: {
        kind: "foreign-key",
        column: "Project.assigneeId",
        constrained: true,
      },
      ownership: {
        kind: "entity",
        entity: "project",
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
        role: "reference",
        label: "project assignee defaults",
        description: "An explicit member default for project work.",
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
              code: "block-project-defaults",
              effect: "block",
              description:
                "Live project assignee defaults retain their member.",
            },
            handler: null,
            order: 3,
          },
          merge: {
            kind: "disposition",
            disposition: {
              code: "repoint-project-defaults",
              effect: "repoint",
              description:
                "Project assignee defaults move to the surviving member.",
            },
            handler: null,
            order: 3,
          },
        },
      },
    }),
    defineEdge({
      key: "Task.assigneeId",
      from: "task",
      to: "ledgerParty",
      cardinality: "one",
      inverse: {
        key: "ledgerParty.incoming.Task.assigneeId",
        from: "ledgerParty",
        to: "task",
        cardinality: "many",
      },
      storage: {
        kind: "foreign-key",
        column: "Task.assigneeId",
        constrained: true,
      },
      ownership: {
        kind: "entity",
        entity: "task",
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
        role: "reference",
        label: "assigned tasks",
        description: "An explicit member assignee on live work.",
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
              code: "block-assigned-tasks",
              effect: "block",
              description: "Live task assignments retain their member.",
            },
            handler: null,
            order: 4,
          },
          merge: {
            kind: "disposition",
            disposition: {
              code: "repoint-assigned-tasks",
              effect: "repoint",
              description: "Task assignments move to the surviving member.",
            },
            handler: null,
            order: 4,
          },
        },
      },
    }),
    defineEdge({
      key: "Purchase.purchaserOverrideId",
      from: "purchase",
      to: "ledgerParty",
      cardinality: "one",
      inverse: {
        key: "ledgerParty.incoming.Purchase.purchaserOverrideId",
        from: "ledgerParty",
        to: "purchase",
        cardinality: "many",
      },
      storage: {
        kind: "foreign-key",
        column: "Purchase.purchaserOverrideId",
        constrained: true,
      },
      ownership: {
        kind: "entity",
        entity: "purchase",
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
        role: "reference",
        label: "purchaser overrides",
        description:
          "An explicit purchaser independent of funding and consumption.",
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
              code: "block-purchasers",
              effect: "block",
              description: "Purchases retain their explicit purchaser.",
            },
            handler: null,
            order: 5,
          },
          merge: {
            kind: "disposition",
            disposition: {
              code: "repoint-purchasers",
              effect: "repoint",
              description: "Purchaser overrides move to the surviving member.",
            },
            handler: null,
            order: 5,
          },
        },
      },
    }),
    defineEdge({
      key: "FinancialAccount.ledgerPartyId",
      from: "financialAccount",
      to: "ledgerParty",
      cardinality: "one",
      inverse: {
        key: "ledgerParty.incoming.FinancialAccount.ledgerPartyId",
        from: "ledgerParty",
        to: "financialAccount",
        cardinality: "many",
      },
      storage: {
        kind: "foreign-key",
        column: "FinancialAccount.ledgerPartyId",
        constrained: true,
      },
      ownership: {
        kind: "entity",
        entity: "financialAccount",
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
        role: "reference",
        label: "financial accounts",
        description:
          "The member or household party an evidence account belongs to.",
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
              code: "block-accounts",
              effect: "block",
              description: "Live accounts retain their ledger party.",
            },
            handler: null,
            order: 6,
          },
          merge: {
            kind: "disposition",
            disposition: {
              code: "repoint-accounts",
              effect: "repoint",
              description: "Accounts move to the surviving party.",
            },
            handler: null,
            order: 6,
          },
        },
      },
    }),
    defineEdge({
      key: "FinancialAccount.primaryCardholderId",
      from: "financialAccount",
      to: "ledgerParty",
      cardinality: "one",
      inverse: {
        key: "ledgerParty.incoming.FinancialAccount.primaryCardholderId",
        from: "ledgerParty",
        to: "financialAccount",
        cardinality: "many",
      },
      storage: {
        kind: "foreign-key",
        column: "FinancialAccount.primaryCardholderId",
        constrained: true,
      },
      ownership: {
        kind: "entity",
        entity: "financialAccount",
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
        role: "reference",
        label: "primary cards",
        description: "The member who primarily uses the credit card.",
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
              code: "block-cardholders",
              effect: "block",
              description: "Live cards retain their primary cardholder.",
            },
            handler: null,
            order: 7,
          },
          merge: {
            kind: "disposition",
            disposition: {
              code: "block-cardholder-merges",
              effect: "block",
              description: "Reconcile card access before merging cardholders.",
            },
            handler: null,
            order: 7,
          },
        },
      },
    }),
    defineEdge({
      key: "Image.capturedByPartyId",
      from: "image",
      to: "ledgerParty",
      cardinality: "one",
      inverse: {
        key: "ledgerParty.incoming.Image.capturedByPartyId",
        from: "ledgerParty",
        to: "image",
        cardinality: "many",
      },
      storage: {
        kind: "foreign-key",
        column: "Image.capturedByPartyId",
        constrained: true,
      },
      ownership: {
        kind: "entity",
        entity: "image",
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
        role: "reference",
        label: "captured images",
        description:
          "The member an image's capture is derived (or manually confirmed) as belonging to.",
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
              code: "clear-captured-by",
              effect: "detach",
              description:
                "Deleting a member clears the derived capturer on its images rather than blocking the delete — the image survives with no capturer until the next derivation.",
            },
            handler: null,
            order: 8,
          },
          merge: {
            kind: "disposition",
            disposition: {
              code: "repoint-captured-by",
              effect: "repoint",
              description:
                "Images derived to a merged member move to the surviving party.",
            },
            handler: null,
            order: 8,
          },
        },
      },
    }),
    defineEdge({
      key: "VendorAccount.ledgerPartyId",
      from: "vendorAccount",
      to: "ledgerParty",
      cardinality: "one",
      inverse: {
        key: "ledgerParty.incoming.VendorAccount.ledgerPartyId",
        from: "ledgerParty",
        to: "vendorAccount",
        cardinality: "many",
      },
      storage: {
        kind: "foreign-key",
        column: "VendorAccount.ledgerPartyId",
        constrained: true,
      },
      ownership: {
        kind: "entity",
        entity: "vendorAccount",
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
        role: "reference",
        label: "vendor accounts",
        description: "A member-owned login used for vendor import automation.",
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
              code: "block-vendor-accounts",
              effect: "block",
              description: "Member-owned vendor accounts retain their owner.",
            },
            handler: null,
            before: {
              module: "~/server/domains/ledger-party/repo/ledger-party",
              export: "beforeLedgerPartyDeletion",
            },
            order: 9,
          },
          merge: {
            kind: "disposition",
            disposition: {
              code: "block-vendor-accounts",
              effect: "block",
              description:
                "Vendor-account ownership must be reconciled before merging members.",
            },
            handler: null,
            order: 9,
          },
        },
      },
    }),
    defineEdge({
      key: "Run.ledgerPartyId",
      from: "run",
      to: "ledgerParty",
      cardinality: "one",
      inverse: {
        key: "ledgerParty.incoming.Run.ledgerPartyId",
        from: "ledgerParty",
        to: "run",
        cardinality: "many",
      },
      storage: {
        kind: "foreign-key",
        column: "Run.ledgerPartyId",
        constrained: true,
      },
      ownership: {
        kind: "entity",
        entity: "run",
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
        label: "import runs",
        description:
          "The member whose evidence was processed by an import run.",
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
              code: "block-runs",
              effect: "block",
              description: "Import provenance retains the member scope.",
            },
            handler: null,
            order: 10,
          },
          merge: {
            kind: "disposition",
            disposition: {
              code: "block-runs",
              effect: "block",
              description: "Import provenance prevents member merges.",
            },
            handler: null,
            order: 10,
          },
        },
      },
    }),
    defineEdge({
      key: "Device.ledgerPartyId",
      from: "device",
      to: "ledgerParty",
      cardinality: "one",
      inverse: {
        key: "ledgerParty.incoming.Device.ledgerPartyId",
        from: "ledgerParty",
        to: "device",
        cardinality: "many",
      },
      storage: {
        kind: "foreign-key",
        column: "Device.ledgerPartyId",
        constrained: true,
      },
      ownership: {
        kind: "entity",
        entity: "device",
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
        role: "reference",
        label: "devices",
        description: "A native companion install owned by this member.",
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
              code: "clear-owner",
              effect: "detach",
              description:
                "Deleting a member clears its devices' owner rather than blocking the delete — a device survives as an unowned install.",
            },
            handler: null,
            order: 11,
          },
          merge: {
            kind: "disposition",
            disposition: {
              code: "repoint-devices",
              effect: "repoint",
              description:
                "A merged member's devices move to the surviving party.",
            },
            handler: null,
            order: 11,
          },
        },
      },
    }),
    defineEdge({
      key: "Email.ledgerPartyId",
      from: "email",
      to: "ledgerParty",
      cardinality: "one",
      inverse: {
        key: "ledgerParty.incoming.Email.ledgerPartyId",
        from: "ledgerParty",
        to: "email",
        cardinality: "many",
      },
      storage: {
        kind: "foreign-key",
        column: "Email.ledgerPartyId",
        constrained: true,
      },
      ownership: {
        kind: "entity",
        entity: "email",
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
        label: "mailbox message status",
        description:
          "Minimal classification and recovery metadata for a member mailbox.",
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
              code: "block-mailbox-messages",
              effect: "block",
              description:
                "Mailbox classification and recovery metadata retain their member scope.",
            },
            handler: null,
            order: 12,
          },
          merge: {
            kind: "disposition",
            disposition: {
              code: "block-mailbox-messages",
              effect: "block",
              description:
                "Mailbox classification and recovery metadata prevent member merges.",
            },
            handler: null,
            order: 12,
          },
        },
      },
    }),
    defineEdge({
      key: "PhotoGroupProposal.inventoryOwnerPartyId",
      from: "row:PhotoGroupProposal",
      to: "ledgerParty",
      cardinality: "one",
      inverse: {
        key: "ledgerParty.incoming.PhotoGroupProposal.inventoryOwnerPartyId",
        from: "ledgerParty",
        to: "row:PhotoGroupProposal",
        cardinality: "many",
      },
      storage: {
        kind: "foreign-key",
        column: "PhotoGroupProposal.inventoryOwnerPartyId",
        constrained: true,
      },
      ownership: {
        kind: "column",
        column: "PhotoGroupProposal.runId",
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
        label: "photo group proposals",
        description:
          "The member a proposed photo group's inventory will belong to; a merge follows it to the survivor.",
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
              code: "clear-proposal-owner",
              effect: "detach",
              description:
                "Deleting a member clears a photo group proposal's inventory owner; the group can still be approved without one.",
            },
            handler: null,
            order: 13,
          },
          merge: {
            kind: "disposition",
            disposition: {
              code: "repoint-proposal-owner",
              effect: "repoint",
              description:
                "A photo group proposed for a merged member is received by the surviving party.",
            },
            handler: null,
            order: 13,
          },
        },
      },
    }),
    defineEdge({
      key: "ImportSourceClaim.ledgerPartyId",
      from: "row:ImportSourceClaim",
      to: "ledgerParty",
      cardinality: "one",
      inverse: {
        key: "ledgerParty.incoming.ImportSourceClaim.ledgerPartyId",
        from: "ledgerParty",
        to: "row:ImportSourceClaim",
        cardinality: "many",
      },
      storage: {
        kind: "foreign-key",
        column: "ImportSourceClaim.ledgerPartyId",
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
        role: "history",
        label: "import source claims",
        description: "The member scope for an idempotent imported source.",
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
              code: "block-import-claims",
              effect: "block",
              description: "Import source claims retain the member scope.",
            },
            handler: null,
            order: 14,
          },
          merge: {
            kind: "disposition",
            disposition: {
              code: "block-import-claims",
              effect: "block",
              description: "Import source identity prevents member merges.",
            },
            handler: null,
            order: 14,
          },
        },
      },
    }),
    defineEdge({
      key: "Suggestion.ledgerPartyId",
      from: "row:Suggestion",
      to: "ledgerParty",
      cardinality: "one",
      inverse: {
        key: "ledgerParty.incoming.Suggestion.ledgerPartyId",
        from: "ledgerParty",
        to: "row:Suggestion",
        cardinality: "many",
      },
      storage: {
        kind: "foreign-key",
        column: "Suggestion.ledgerPartyId",
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
        role: "history",
        label: "import findings",
        description: "The member whose import requires review.",
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
              code: "block-import-findings",
              effect: "block",
              description: "Import findings retain the member scope.",
            },
            handler: null,
            order: 15,
          },
          merge: {
            kind: "disposition",
            disposition: {
              code: "block-import-findings",
              effect: "block",
              description: "Import findings prevent member merges.",
            },
            handler: null,
            order: 15,
          },
        },
      },
    }),
    defineEdge({
      key: "RunFinding.ledgerPartyId",
      from: "row:RunFinding",
      to: "ledgerParty",
      cardinality: "one",
      inverse: {
        key: "ledgerParty.incoming.RunFinding.ledgerPartyId",
        from: "ledgerParty",
        to: "row:RunFinding",
        cardinality: "many",
      },
      storage: {
        kind: "foreign-key",
        column: "RunFinding.ledgerPartyId",
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
        role: "history",
        label: "run findings",
        description: "The member whose import finding requires review.",
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
              code: "block-import-findings",
              effect: "block",
              description: "Import findings retain the member scope.",
            },
            handler: null,
            order: 16,
          },
          merge: {
            kind: "disposition",
            disposition: {
              code: "block-import-findings",
              effect: "block",
              description: "Import findings prevent member merges.",
            },
            handler: null,
            order: 16,
          },
        },
      },
    }),
    defineEdge({
      key: "MailboxCursor.ledgerPartyId",
      from: "row:MailboxCursor",
      to: "ledgerParty",
      cardinality: "one",
      inverse: {
        key: "ledgerParty.incoming.MailboxCursor.ledgerPartyId",
        from: "ledgerParty",
        to: "row:MailboxCursor",
        cardinality: "many",
      },
      storage: {
        kind: "foreign-key",
        column: "MailboxCursor.ledgerPartyId",
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
        role: "metadata",
        label: "mailbox cursors",
        description: "A member mailbox's durable Gmail history cursor.",
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
              code: "block-mailbox-cursor",
              effect: "block",
              description: "Mailbox cursors retain their member scope.",
            },
            handler: null,
            order: 17,
          },
          merge: {
            kind: "disposition",
            disposition: {
              code: "block-mailbox-cursor",
              effect: "block",
              description: "Mailbox identity prevents member merges.",
            },
            handler: null,
            order: 17,
          },
        },
      },
    }),
    defineEdge({
      key: "OrderMail.ledgerPartyId",
      from: "row:OrderMail",
      to: "ledgerParty",
      cardinality: "one",
      inverse: {
        key: "ledgerParty.incoming.OrderMail.ledgerPartyId",
        from: "ledgerParty",
        to: "row:OrderMail",
        cardinality: "many",
      },
      storage: {
        kind: "foreign-key",
        column: "OrderMail.ledgerPartyId",
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
        role: "history",
        label: "order mail",
        description: "Normalized order evidence from a member mailbox.",
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
              code: "block-order-mail",
              effect: "block",
              description: "Order mail retains its member scope.",
            },
            handler: null,
            order: 18,
          },
          merge: {
            kind: "disposition",
            disposition: {
              code: "block-order-mail",
              effect: "block",
              description: "Order mail provenance prevents member merges.",
            },
            handler: null,
            order: 18,
          },
        },
      },
    }),
    defineEdge({
      key: "MealFoodEntry.ledgerPartyId",
      from: "row:MealFoodEntry",
      to: "ledgerParty",
      cardinality: "one",
      inverse: {
        key: "ledgerParty.incoming.MealFoodEntry.ledgerPartyId",
        from: "ledgerParty",
        to: "row:MealFoodEntry",
        cardinality: "many",
      },
      storage: {
        kind: "foreign-key",
        column: "MealFoodEntry.ledgerPartyId",
        constrained: true,
      },
      ownership: {
        kind: "column",
        column: "MealFoodEntry.mealId",
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
        role: "association",
        label: "meal food entries",
        description:
          "A product or manual food amount naming this member or guest as its eater.",
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
              code: "block-meal-food-entries",
              effect: "block",
              description: "Live meal food entries retain their eater.",
            },
            handler: null,
            order: 19,
          },
          merge: {
            kind: "disposition",
            disposition: {
              code: "repoint-meal-food-entries",
              effect: "repoint",
              description:
                "Meal food entries move to the surviving party without changing their recorded amounts.",
            },
            handler: null,
            order: 19,
          },
        },
      },
    }),
    defineEdge({
      key: "ExpenseAttribution.ledgerPartyId",
      from: "row:ExpenseAttribution",
      to: "ledgerParty",
      cardinality: "one",
      inverse: {
        key: "ledgerParty.incoming.ExpenseAttribution.ledgerPartyId",
        from: "ledgerParty",
        to: "row:ExpenseAttribution",
        cardinality: "many",
      },
      storage: {
        kind: "foreign-key",
        column: "ExpenseAttribution.ledgerPartyId",
        constrained: true,
      },
      ownership: {
        kind: "column",
        column: "ExpenseAttribution.expenseId",
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
        role: "ledger",
        label: "beneficiary attributions",
        description:
          "A weighted expense beneficiary or funder share; money remains on the expense itself.",
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
              code: "block-attributions",
              effect: "block",
              description: "Live expense shares retain their party.",
            },
            handler: null,
            order: 20,
          },
          merge: {
            kind: "disposition",
            disposition: {
              code: "merge-attributions",
              effect: "move-dedupe",
              description: "Colliding weighted shares are summed.",
            },
            handler: {
              module: "~/server/domains/ledger-party/repo/ledger-party",
              export: "ledgerPartyMergeEdgeHandlers",
              member: "foldWeightedAttributions",
            },
            order: 20,
          },
        },
      },
    }),
    defineEdge({
      key: "MealRecipePortion.ledgerPartyId",
      from: "row:MealRecipePortion",
      to: "ledgerParty",
      cardinality: "one",
      inverse: {
        key: "ledgerParty.incoming.MealRecipePortion.ledgerPartyId",
        from: "ledgerParty",
        to: "row:MealRecipePortion",
        cardinality: "many",
      },
      storage: {
        kind: "foreign-key",
        column: "MealRecipePortion.ledgerPartyId",
        constrained: true,
      },
      ownership: {
        kind: "column",
        column: "MealRecipePortion.mealId",
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
        role: "association",
        label: "meal portions",
        description:
          "A planned or confirmed recipe portion naming this member or guest as its eater.",
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
              code: "block-meal-portions",
              effect: "block",
              description: "Live meal portions retain their eater.",
            },
            handler: null,
            order: 21,
          },
          merge: {
            kind: "disposition",
            disposition: {
              code: "merge-meal-portions",
              effect: "move-dedupe",
              description:
                "Colliding portions for one preparation and target meal are summed when their entered units match; confirmation survives only when every folded portion was confirmed.",
            },
            handler: {
              module: "~/server/domains/ledger-party/repo/ledger-party",
              export: "ledgerPartyMergeEdgeHandlers",
              member: "foldPortions",
            },
            order: 21,
          },
        },
      },
    }),
    defineEdge({
      key: "ImageSighting.ledgerPartyId",
      from: "row:ImageSighting",
      to: "ledgerParty",
      cardinality: "one",
      inverse: {
        key: "ledgerParty.incoming.ImageSighting.ledgerPartyId",
        from: "ledgerParty",
        to: "row:ImageSighting",
        cardinality: "many",
      },
      storage: {
        kind: "foreign-key",
        column: "ImageSighting.ledgerPartyId",
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
        role: "reference",
        label: "image sightings",
        description:
          "The member whose photo library or cloud account a sighting was reported from.",
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
              code: "block-image-sightings",
              effect: "block",
              description:
                "A sighting's library owner retains its member scope; the reported evidence would be meaningless attached to no one.",
            },
            handler: null,
            order: 22,
          },
          merge: {
            kind: "disposition",
            disposition: {
              code: "repoint-image-sightings",
              effect: "repoint",
              description:
                "A merged member's reported image sightings move to the surviving party.",
            },
            handler: null,
            order: 22,
          },
        },
      },
    }),
  ],

  names: { singular: "Ledger Party", plural: "Ledger Parties" },
  route: { basePath: "ledger-parties" },
  table: "LedgerParty",
  identifiers: {
    brand: "LedgerPartyId",
    shortcode: "LPY-",
    currentMember: true,
  },
  presentation: {
    list: {},
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
      summary: [
        {
          kind: "report",
          id: "contribution",
          title: "Contribution context",
          slot: "ledgerParty.contribution-summary",
        },
        {
          kind: "records",
          id: "assigned-work",
          title: "Assigned Tasks",
          viewKey: "relation:tasks",
        },
        {
          kind: "records",
          id: "accounts",
          title: "Financial accounts",
          viewKey: "relation:financial-accounts",
        },
        {
          kind: "report",
          id: "owned-holdings",
          title: "Owned holdings",
          slot: "ledgerParty.owned-holdings",
        },
        {
          kind: "records",
          id: "recent-meals",
          title: "Meals",
          viewKey: "relation:meals",
        },
        {
          kind: "records",
          id: "outgoing-transfers",
          title: "Outgoing transfers",
          viewKey: "relation:outgoing-transfers",
        },
        {
          kind: "records",
          id: "incoming-transfers",
          title: "Incoming transfers",
          viewKey: "relation:incoming-transfers",
        },
        {
          kind: "records",
          id: "devices",
          title: "Devices",
          viewKey: "relation:devices",
        },
      ],

      activityRelations: [
        { relation: "expenses", dateField: "date" },
        { relation: "outgoing-transfers", dateField: "date" },
        { relation: "incoming-transfers", dateField: "date" },
        { relation: "meals", dateField: "date" },
        { relation: "tasks", dateField: "dueDate" },
        { relation: "images", dateField: "capturedAt" },
        { relation: "emails", dateField: "receivedAt" },
      ],

      omitRelations: {
        "recipes-eaten":
          "Reachable through the Meals table on this page; the recipe rollup is three joins deep.",
      },
      sections: [
        {
          kind: "fields",
          id: "overview",
          title: "Record",
          fields: ["name", "kind", "notes"],
        },
        {
          kind: "fields",
          id: "coverage",
          title: "Coverage and summaries",
          fields: ["createdAt", "updatedAt"],
        },
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
        display: {},
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
        control: {
          kind: "select",
          options: selectControlOptions.ledgerPartyKind,
        },
        display: {
          columnGroup: "Party",
          mobile: { slot: "subtitle", priority: 10 },
        },
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
        display: { columnGroup: "Party", width: "xl" },
        validation: {
          read: z.string().nullable(),
          create: z.string().nullable().default(null),
          update: z.string().nullable().optional(),
        },
      },
      idField(ledgerPartyShortcode),
      timestampField("createdAt"),
      timestampField("updatedAt"),
      { output: false, key: "shortcode", kind: "text" },
      { output: false, key: "deletedAt", kind: "timestamp", nullable: true },
    ],
    storage: [
      {
        key: "id",
        specialized: "primary-key:LedgerPartyId",
      },
      { key: "shortcode", specialized: "shortcode" },
      "name",
      {
        key: "kind",
        specialized: "enum:kind",
        type: {
          module: "@cubby/schemas/ledger-party-fields",
          export: "LedgerPartyKind",
        },
      },
      "notes",
      { key: "createdAt" },
      { key: "updatedAt", specialized: "updated-at" },
      "deletedAt",
    ],

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
  },

  // A durable economic participant in the household ledger.
  storage: {
    columns: [
      // Auth ownership is intentionally storage-only: a member claims it from
      // Settings, never through generic ledger-party create/update forms.
      {
        key: "userId",
        kind: "text",
        type: { module: "@cubby/schemas/identifiers", export: "UserId" },
        reference: "user",
      },
    ],
    indexes: [
      { on: ["kind"] },
      {
        name: "LedgerParty_household_singleton_key",
        on: ["kind"],
        unique: true,
        where: "{deletedAt} IS NULL AND {kind} = 'household'",
      },
      {
        name: "LedgerParty_member_user_key",
        on: ["userId"],
        unique: true,
        where: "{deletedAt} IS NULL AND {userId} IS NOT NULL",
      },
    ],
    checks: [
      { column: "kind" },
      {
        name: "LedgerParty_user_member_check",
        sql: "{userId} IS NULL OR {kind} = 'member'",
      },
    ],
    unindexedReferences: {
      userId:
        "a member's claim is found through the live partial unique LedgerParty_member_user_key",
    },
    relations: {
      accounts: { many: "financialAccount" },
      attributions: { many: "expenseAttribution" },
      mealRecipePortions: { many: "mealRecipePortion" },
      outgoingTransfers: {
        many: "ledgerTransfer",
        relationName: "LedgerTransferFromParty",
      },
      incomingTransfers: {
        many: "ledgerTransfer",
        relationName: "LedgerTransferToParty",
      },
    },
  },
  filters: {
    audit: true,

    descriptors: [
      {
        columnId: "name",
        field: "search",
        urlKey: "q",
        kind: "text",
        placeholder: "Search ledger parties...",
        deriveSchema: true,
        anyOf: ["name"],
      },
      {
        columnId: "kind",
        kind: "multiselect",
        placeholder: "Filter by kind...",
        deriveSchema: true,
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
      },
      {
        columnId: "mealPresenceFilter",
        kind: "presence",
        placeholder: "Filter related meals presence...",
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
      },
      {
        columnId: "recipePresenceFilter",
        kind: "presence",
        placeholder: "Filter related recipes presence...",
      },
    ],
  },

  search: false,
  capabilities: {
    suggestions: ["transfer_pair"],
    images: { storage: false },
    countable: false,
    delete: { mode: "soft", bulk: true },
    merge: true,
    dataQuality: {
      inputs: [
        {
          table: "FinancialAccount",
          match: { ledgerPartyId: "id" },
          columns: ["deletedAt"],
        },
      ],

      checks: [
        {
          id: "ledger_party_financial_account",
          satisfiedLabel: "Financial account linked",
          placement: { section: "financial-accounts" },
          facet: "linkage",
          label: "Financial account",
          message: "No financial account is linked to this member.",
        },
      ],
    },
  },
  extensions: {
    ports: {
      reports: {
        module: "~/server/domains/ledger-party/repo/report-bindings",
        export: "reportBindings",
      },
      repository: {
        module: "~/server/domains/ledger-party/repo/ledger-party.repository",
        export: "ledgerPartyRepository",
      },
    },
  },
});

export default defineEntity(
  definition,
  (r) => ({
    edges: [
      // The Purchases whose effective purchaserId is this member (ADR 0011).
      r.declare(
        r
          .derived("purchase", "many", "purchaserId", [
            "Purchase",
            "FinancialTransactionAllocation",
            "VendorAccount",
            "ImportSourceOrder",
            "OrderMailEvent",
          ])
          .named("purchases", "Purchases", {
            sources: [
              r
                .query("memberPurchases", "many")
                .source("effective-purchaser", "Effective purchaser"),
            ],
          }),
        "purchase.ledgerParty.purchases",
      ),
      r.declare(
        r
          .path("expense", "many", [
            { edge: "ExpenseAttribution.ledgerPartyId", direction: "incoming" },
            { edge: "ExpenseAttribution.expenseId", direction: "outgoing" },
          ])
          .named("expenses", "Attributed expenses"),
        "expense.ledgerParty.expenses",
      ),
      r.declare(
        r
          .path("financialAccount", "many", [
            { edge: "FinancialAccount.ledgerPartyId", direction: "incoming" },
          ])
          .named("financial-accounts", "Financial accounts"),
        "financialAccount.ledger-party",
      ),
      r.declare(
        r
          .path("ledgerTransfer", "many", [
            { edge: "LedgerTransfer.fromPartyId", direction: "incoming" },
          ])
          .named("outgoing-transfers", "Outgoing transfers"),
        "ledgerTransfer.from-party",
      ),
      r.declare(
        r
          .path("ledgerTransfer", "many", [
            { edge: "LedgerTransfer.toPartyId", direction: "incoming" },
          ])
          .named("incoming-transfers", "Incoming transfers"),
        "ledgerTransfer.to-party",
      ),
      r.declare(
        r
          .path("meal", "many", [
            { edge: "MealFoodEntry.ledgerPartyId", direction: "incoming" },
            { edge: "MealFoodEntry.mealId", direction: "outgoing" },
          ])
          .named("meals", "Meals eaten", {
            view: {
              columnGroup: "Meals",
              order: "newest",
              inverseKey: "meal.eaters",
            },
            sourceKey: "food-entries",
            sources: [
              r
                .path("meal", "many", [
                  {
                    edge: "MealRecipePortion.ledgerPartyId",
                    direction: "incoming",
                  },
                  { edge: "MealRecipePortion.mealId", direction: "outgoing" },
                ])
                .source("portions", "Served portions"),
            ],
          }),
        "meal.eaters",
      ),
      r.declare(
        r
          .path("recipe", "many", [
            { edge: "MealRecipePortion.ledgerPartyId", direction: "incoming" },
            { edge: "MealRecipePortion.mealRecipeId", direction: "outgoing" },
            { edge: "MealRecipe.recipeId", direction: "outgoing" },
          ])
          .named("recipes-eaten", "Recipes eaten", {
            view: { key: "recipesEaten", columnGroup: "Meals" },
          }),
        "recipe.ledgerParty.recipes-eaten",
      ),
    ],
  }),
  readSchemas,
);
