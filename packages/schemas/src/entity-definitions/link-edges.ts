import { defineEdge } from "./edges";

export const declaredLinkEdges = [
  defineEdge({
    key: "EntityLink[purchaseProduct]",
    from: "purchase",
    to: "product",
    cardinality: "many",
    inverse: {
      key: "EntityLink[purchaseProduct].inverse",
      from: "product",
      to: "purchase",
      cardinality: "many",
    },
    storage: {
      kind: "link",
      linkKind: "purchaseProduct",
      quantity: false,
      forbidSelfLink: false,
      acyclic: false,
      onMergeCollision: {
        from: "dropLoser",
        to: "dropLoser",
      },
    },
    ownership: {
      kind: "link-from",
      column: "EntityLink.fromEntityId",
    },
    fromEnd: {
      role: "association",
      label: "products",
      description:
        "A Product associated with this order; acquisition requires explicit confirmation. Carries no money — spend stays entirely on Expense — so this never doubles as a second ledger path.",
      liveness: {
        kind: "must-target-live",
      },
    },
    toEnd: {
      role: "acquisition",
      label: "purchase links",
      description:
        "The vendor order linked to this Product; an unconfirmed link is identity evidence only. Provenance, not money — it exists because an order paid in installments is an `allocation` whose Expenses can never carry a productId, leaving the goods with no path back to the order.",
      liveness: {
        kind: "must-target-live",
      },
    },
    policies: {
      from: {
        delete: {
          kind: "disposition",
          disposition: {
            code: "soft-delete-association",
            effect: "soft-delete",
            description:
              "Product links are soft-deleted with the purchase; the Products themselves are not.",
          },
          handler: null,
          order: 7,
        },
        merge: {
          kind: "disposition",
          disposition: {
            code: "move-dedupe-and-soft-delete-source",
            effect: "move-dedupe",
            description:
              "The absorbed purchase's product links move onto the survivor, skipping products already linked there, and the source links are soft-deleted.",
          },
          handler: null,
          order: 7,
        },
      },
      to: {
        delete: {
          kind: "disposition",
          disposition: {
            code: "block-live-purchase-link",
            effect: "block",
            description:
              "A product recorded against the order that bought it can't be deleted — that link is often the only path back to the purchase, since an installment order's expenses can't carry a product.",
            reason: "PRODUCT_HAS_PURCHASE_LINKS",
            label: "purchase links",
          },
          handler: {
            module: "~/server/domains/product/repo/crud",
            export: "refuseProductDeletion",
            argument: "EntityLink[purchaseProduct].to",
          },
          order: 14,
        },
        merge: {
          kind: "disposition",
          disposition: {
            code: "repoint-or-drop-same-purchase",
            effect: "move-dedupe",
            description:
              "A merged product's purchase links move onto the survivor, skipping orders the survivor is already recorded against.",
          },
          handler: {
            module: "~/server/domains/product/repo/merge",
            export: "productMergeEdgeHandlers",
            member: "movePurchaseLinks",
          },
          order: 14,
        },
      },
    },
  }),
  defineEdge({
    key: "EntityLink[purchasePaymentAccount]",
    from: "purchase",
    to: "financialAccount",
    cardinality: "many",
    inverse: {
      key: "EntityLink[purchasePaymentAccount].inverse",
      from: "financialAccount",
      to: "purchase",
      cardinality: "many",
    },
    storage: {
      kind: "link",
      linkKind: "purchasePaymentAccount",
      quantity: false,
      forbidSelfLink: false,
      acyclic: false,
      onMergeCollision: {
        from: "dropLoser",
        to: "dropLoser",
      },
    },
    ownership: {
      kind: "link-from",
      column: "EntityLink.fromEntityId",
    },
    fromEnd: {
      role: "reference",
      label: "payment accounts",
      description:
        "A member's assertion that this account paid for the order. When an order has none, its paying accounts are derived on read from its payment evidence; an explicit link always wins. Carries no money.",
      liveness: {
        kind: "must-target-live",
      },
    },
    toEnd: {
      role: "reference",
      label: "paid purchases",
      description:
        "A vendor order a member confirmed this account paid for; settlement checks refuse a charge from an account the order names none of.",
      liveness: {
        kind: "must-target-live",
      },
    },
    policies: {
      from: {
        delete: {
          kind: "disposition",
          disposition: {
            code: "soft-delete-association",
            effect: "soft-delete",
            description:
              "Payment-account links are soft-deleted with the purchase; the accounts themselves are not.",
          },
          handler: null,
          order: 8,
        },
        merge: {
          kind: "disposition",
          disposition: {
            code: "move-dedupe-and-soft-delete-source",
            effect: "move-dedupe",
            description:
              "The absorbed purchase's payment-account links move onto the survivor, skipping accounts already linked there, and the source links are soft-deleted.",
          },
          handler: null,
          order: 8,
        },
      },
      to: {
        delete: {
          kind: "disposition",
          disposition: {
            code: "soft-delete-association",
            effect: "soft-delete",
            description:
              "A member's assertion that this account paid an order is soft-deleted with the account; the order's paying accounts fall back to its payment evidence.",
          },
          handler: null,
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
    key: "EntityLink[projectTool]",
    from: "project",
    to: "product",
    cardinality: "many",
    inverse: {
      key: "EntityLink[projectTool].inverse",
      from: "product",
      to: "project",
      cardinality: "many",
    },
    storage: {
      kind: "link",
      linkKind: "projectTool",
      quantity: false,
      forbidSelfLink: false,
      acyclic: false,
      onMergeCollision: {
        from: "dropLoser",
        to: "dropLoser",
      },
    },
    ownership: {
      kind: "link-from",
      column: "EntityLink.fromEntityId",
    },
    fromEnd: {
      role: "association",
      label: "reusable resources",
      description:
        "A durable association recording a reusable tool or software Product used on this exact project.",
      liveness: {
        kind: "must-target-live",
      },
    },
    toEnd: {
      role: "history",
      label: "project uses",
      description:
        "Durable history that this reusable tool or software Product was used on a household project; deleting the Product would leave that history nameless.",
      liveness: {
        kind: "must-target-live",
      },
    },
    policies: {
      from: {
        delete: {
          kind: "disposition",
          disposition: {
            code: "soft-delete-association",
            effect: "soft-delete",
            description:
              "Tool-use associations are soft-deleted with the project; the tool Products and their other project history remain.",
          },
          handler: null,
          order: 6,
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
            code: "block-live-project-use",
            effect: "block",
            description:
              "A reusable resource with project-use history can't be deleted — detach that history first.",
            reason: "PRODUCT_HAS_PROJECT_USES",
            label: "project uses",
          },
          handler: {
            module: "~/server/domains/product/repo/crud",
            export: "refuseProductDeletion",
            argument: "EntityLink[projectTool].to",
          },
          order: 15,
        },
        merge: {
          kind: "disposition",
          disposition: {
            code: "repoint-or-drop-same-project",
            effect: "move-dedupe",
            description:
              "A merged product's project-use history moves onto the survivor, skipping projects the survivor is already recorded on.",
          },
          handler: {
            module: "~/server/domains/product/repo/merge",
            export: "productMergeEdgeHandlers",
            member: "foldProjectUses",
          },
          order: 15,
        },
      },
    },
  }),
  defineEdge({
    key: "EntityLink[gardenEntryPlanting]",
    from: "gardenEntry",
    to: "planting",
    cardinality: "many",
    inverse: {
      key: "EntityLink[gardenEntryPlanting].inverse",
      from: "planting",
      to: "gardenEntry",
      cardinality: "many",
    },
    storage: {
      kind: "link",
      linkKind: "gardenEntryPlanting",
      quantity: false,
      forbidSelfLink: false,
      acyclic: false,
      onMergeCollision: {
        from: "dropLoser",
        to: "dropLoser",
      },
    },
    ownership: {
      kind: "link-from",
      column: "EntityLink.fromEntityId",
    },
    fromEnd: {
      role: "history",
      label: "planting associations",
      description:
        "A live association records which growing attempts a garden entry describes.",
      liveness: {
        kind: "must-target-live",
      },
    },
    toEnd: {
      role: "history",
      label: "garden entries",
      description:
        "Garden observations and harvests retain the planting they describe.",
      liveness: {
        kind: "must-target-live",
      },
    },
    policies: {
      from: {
        delete: {
          kind: "disposition",
          disposition: {
            code: "soft-delete-association",
            effect: "soft-delete",
            description:
              "Planting associations are removed with the garden entry; plantings remain.",
          },
          handler: null,
          order: 1,
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
            code: "soft-delete-association",
            effect: "soft-delete",
            description:
              "A garden entry outlives the planting it described; only that association is detached.",
          },
          handler: null,
          before: {
            module: "~/server/domains/garden/repo/repository",
            export: "plantingDeleteEdgeHandlers",
            member: "auditMemberships",
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
    key: "EntityLink[productComponent]",
    from: "product",
    to: "product",
    cardinality: "many",
    inverse: {
      key: "EntityLink[productComponent].inverse",
      from: "product",
      to: "product",
      cardinality: "many",
    },
    storage: {
      kind: "link",
      linkKind: "productComponent",
      quantity: true,
      forbidSelfLink: true,
      acyclic: true,
      onMergeCollision: {
        from: "dedupeEqualQuantityElseRefuse",
        to: "sumQuantity",
      },
    },
    ownership: {
      kind: "link-from",
      column: "EntityLink.fromEntityId",
    },
    fromEnd: {
      role: "composition",
      label: "kit components",
      description:
        "A row on this Product's own component list — what's inside it, when it's a kit or multi-pack. Deleting the kit takes its component list with it.",
      liveness: {
        kind: "must-target-live",
      },
    },
    toEnd: {
      role: "usage",
      label: "kits it's listed inside",
      description:
        "This Product cited as a part of another (kit) Product's component list, with its own quantity. The kit and the part remain independently real products; this only says the part is currently accounted for inside the kit.",
      liveness: {
        kind: "must-target-live",
      },
    },
    policies: {
      from: {
        delete: {
          kind: "disposition",
          disposition: {
            code: "soft-delete-kit-components",
            effect: "soft-delete",
            description:
              "Deleting a kit takes its own component list with it — the individual component Products are untouched.",
          },
          handler: null,
          order: 16,
        },
        merge: {
          kind: "disposition",
          disposition: {
            code: "repoint-or-dedupe-identical-component",
            effect: "move-dedupe",
            description:
              "A merged kit's own component list moves onto the survivor; a part both kits list at the SAME quantity is deduped, and one they list at different quantities refuses the merge rather than inventing or destroying units.",
          },
          handler: {
            module: "~/server/domains/product/repo/merge",
            export: "productMergeEdgeHandlers",
            member: "moveKitComponents",
          },
          order: 16,
        },
      },
      to: {
        delete: {
          kind: "disposition",
          disposition: {
            code: "block-live-kit-membership",
            effect: "block",
            description:
              "A product still listed inside a live kit's component list can't be deleted — remove it from the kit first.",
            reason: "PRODUCT_HAS_KIT_LINKS",
            label: "kits it's listed inside",
          },
          handler: {
            module: "~/server/domains/product/repo/crud",
            export: "refuseProductDeletion",
            argument: "EntityLink[productComponent].to",
          },
          order: 17,
        },
        merge: {
          kind: "disposition",
          disposition: {
            code: "repoint-or-sum-same-kit",
            effect: "move-dedupe",
            description:
              "Kits that listed a merged product as a part now list the survivor; where one kit listed both, the two quantities are summed into the survivor's row and the absorbed one is soft-deleted.",
          },
          handler: {
            module: "~/server/domains/product/repo/merge",
            export: "productMergeEdgeHandlers",
            member: "moveComponentMemberships",
          },
          order: 17,
        },
      },
    },
  }),
  defineEdge({
    key: "EntityLink[taskDependency]",
    from: "task",
    to: "task",
    cardinality: "many",
    inverse: {
      key: "EntityLink[taskDependency].inverse",
      from: "task",
      to: "task",
      cardinality: "many",
    },
    storage: {
      kind: "link",
      linkKind: "taskDependency",
      quantity: false,
      forbidSelfLink: true,
      acyclic: true,
      onMergeCollision: {
        from: "dropLoser",
        to: "dropLoser",
      },
    },
    ownership: {
      kind: "link-from",
      column: "EntityLink.fromEntityId",
    },
    fromEnd: {
      role: "dependency",
      label: "blocked-by dependencies",
      description:
        "A dependency edge naming this task as the one blocked, waiting on another task to finish first.",
      liveness: {
        kind: "must-target-live",
      },
    },
    toEnd: {
      role: "dependency",
      label: "blocking dependencies",
      description:
        "A dependency edge naming this task as the blocker another task is waiting on.",
      liveness: {
        kind: "must-target-live",
      },
    },
    policies: {
      from: {
        delete: {
          kind: "disposition",
          disposition: {
            code: "soft-delete-dependency",
            effect: "soft-delete",
            description:
              "Blocks/blocked-by dependency links naming the task (or a cascaded subtask) are soft-deleted with it.",
          },
          handler: null,
          order: 4,
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
            code: "soft-delete-dependency",
            effect: "soft-delete",
            description:
              "Blocks/blocked-by dependency links naming the task (or a cascaded subtask) are soft-deleted with it.",
          },
          handler: null,
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
    key: "EntityLink[projectDependency]",
    from: "project",
    to: "project",
    cardinality: "many",
    inverse: {
      key: "EntityLink[projectDependency].inverse",
      from: "project",
      to: "project",
      cardinality: "many",
    },
    storage: {
      kind: "link",
      linkKind: "projectDependency",
      quantity: false,
      forbidSelfLink: true,
      acyclic: true,
      onMergeCollision: {
        from: "dropLoser",
        to: "dropLoser",
      },
    },
    ownership: {
      kind: "link-from",
      column: "EntityLink.fromEntityId",
    },
    fromEnd: {
      role: "dependency",
      label: "blocked-by dependencies",
      description:
        "A dependency edge naming this project as the one blocked, waiting on another project to finish first.",
      liveness: {
        kind: "must-target-live",
      },
    },
    toEnd: {
      role: "dependency",
      label: "blocking dependencies",
      description:
        "A dependency edge naming this project as the blocker another project is waiting on.",
      liveness: {
        kind: "must-target-live",
      },
    },
    policies: {
      from: {
        delete: {
          kind: "disposition",
          disposition: {
            code: "soft-delete-dependency",
            effect: "soft-delete",
            description:
              "Blocks/blocked-by dependency links naming the project are soft-deleted with it.",
          },
          handler: null,
          order: 7,
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
            code: "soft-delete-dependency",
            effect: "soft-delete",
            description:
              "Blocks/blocked-by dependency links naming the project are soft-deleted with it.",
          },
          handler: null,
          order: 8,
        },
        merge: {
          kind: "unsupported",
          reason: "This operation is not exposed for this endpoint.",
        },
      },
    },
  }),
];
