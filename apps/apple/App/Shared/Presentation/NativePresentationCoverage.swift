import CubbyKit

/// The native implementation boundary for manifest-declared presentation names.
///
/// Every generated renderer id is classified here so a new manifest declaration cannot
/// accidentally look native merely because a generic value happens to be printable. A
/// non-nil unsupported reason is intentional: callers surface one web disclosure instead
/// of silently dropping a field or slot.
enum NativePresentationCoverage {
    enum Status: Equatable, Sendable {
        case implemented
        case generic
        case ownedElsewhere
        case unsupported(String)

        var isUnsupported: Bool {
            if case .unsupported = self { return true }
            return false
        }
    }

    static func control(_ renderer: ControlRendererID) -> Status {
        switch renderer {
        case .amount, .entityMultiSelect, .ledgerAttributions, .tagList, .vendorName:
            .implemented
        case .entitySelect, .money, .url:
            .generic
        case .imageOrder:
            .ownedElsewhere
        case .structuredField:
            .unsupported("Structured fields are available on web.")
        }
    }

    static func list(_ renderer: ListRendererID) -> Status {
        switch renderer {
        case .recipeSource: .implemented
        }
    }

    static func detail(_ renderer: DetailRendererID) -> Status {
        switch renderer {
        case .expenseProject,
            .ownerLedgerPartyId,
            .ownershipMode,
            .productFdcId,
            .productExternalIds,
            .productId,
            .productIngredient,
            .productPrimaryGtin,
            .productTags,
            .financialTransactionAllocations:
            .generic
        case .recipeSource:
            .implemented
        case .effectiveOwnership:
            .ownedElsewhere
        case .productCategoryPath,
            .financialAccountIdentity,
            .financialAccountSourceAliases,
            .financialTransactionSourceRefs,
            .financialTransactionVendorInference,
            .ledgerTransferClassification,
            .recipeMeta,
            .recipeSections,
            .recipeTotals,
            .vendorAgentHints,
            .wishCandidates,
            .recipeYield:
            .unsupported("This structured detail is available on web.")
        }
    }

    /// Detail slots are entity-qualified in the generated catalog. Keep every declared id in
    /// this switch, including slots that currently have no native body, so an unqualified id or
    /// a newly copied slot cannot accidentally select the wrong entity's implementation.
    static func detailSlot(_ id: String) -> Status {
        switch id {
        case "ledgerParty.wardrobe", "meal.nutrition": .implemented
        case "product.labels",
            "product.nutrition",
            "product.unit-mappings",
            "product.fits-with",
            "product.cookbooks",
            "product.recipe-appearances",
            "recipe.workflow",
            "ingredient.nutrition-product",
            "cookbook.toc",
            "cookbook.import-progress",
            "location.contents-valuation",
            "location.ai-description",
            "meal.composition",
            "project.budget",
            "project.contribution",
            "project.analytics",
            "purchase.project-allocation",
            "purchase.import-runs",
            "purchase.reconciliation",
            "purchase.financial-settlement",
            "expense.settlement",
            "image.associations":
            .unsupported("This detail is available on web.")
        default:
            .unsupported("Unknown native detail slot.")
        }
    }

    /// List slots are deliberately web-owned. Native list selection filters them out, while this
    /// explicit roster keeps qualified ids from being treated as ordinary table identifiers.
    static func listSlot(_ id: String) -> Status {
        switch id {
        case "location.gallery",
            "location.visualizations",
            "meal.calendar",
            "meal.nutrition",
            "project.overview",
            "project.analytics",
            "project.gallery",
            "task.agenda",
            "task.board",
            "expense.analytics":
            .ownedElsewhere
        default:
            .unsupported("Unknown native list slot.")
        }
    }
    static func unsupportedControl(_ field: FieldDescriptor) -> String? {
        guard let renderer = field.controlRenderer else { return nil }
        guard case .unsupported(let reason) = control(renderer) else { return nil }
        return reason
    }

    static func unsupportedDetail(_ field: FieldDescriptor) -> String? {
        guard let renderer = field.detailRenderer else { return nil }
        guard case .unsupported(let reason) = detail(renderer) else { return nil }
        return reason
    }

    static func unsupportedSlot(_ slot: String) -> String? {
        guard case .unsupported(let reason) = detailSlot(slot) else { return nil }
        return reason
    }
}
