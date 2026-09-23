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

    /// Control renderers with a typed native control of their own.
    private static let implementedControls: Set<ControlRendererID> = [
        .amount, .entityMultiSelect, .ledgerAttributions, .tagList, .vendorName,
    ]
    /// Control renderers drawn by the primitive control of their `controlKind`. `upcLookup`/
    /// `usdaFood` are plain text/number fields on web too once their AI action strips away —
    /// the native shell just draws the primitive control and skips the action.
    private static let genericControls: Set<ControlRendererID> = [
        .entitySelect, .money, .url, .upcLookup, .usdaFood,
    ]
    /// Control renderers the editor's image block owns; never a field control.
    private static let imageBlockControls: Set<ControlRendererID> = [.imageOrder]

    /// An explicit allowlist rather than an exhaustive switch: `ControlRendererID` is generated
    /// from the manifest, so a renderer a web-only field declares (`unit-mappings`,
    /// `label-nutrition`, …) exists here the moment it is declared, and must classify as
    /// unsupported until a native control is written for it — not break the build or fall
    /// through as generic.
    static func control(_ renderer: ControlRendererID) -> Status {
        if implementedControls.contains(renderer) { return .implemented }
        if genericControls.contains(renderer) { return .generic }
        if imageBlockControls.contains(renderer) { return .ownedElsewhere }
        if renderer == .structuredField {
            return .unsupported("Structured fields are available on web.")
        }
        return .unsupported("No native control for \(renderer.rawValue); edit it on web.")
    }

    static func list(_ renderer: ListRendererID) -> Status {
        switch renderer {
        case .recipeSource: .implemented
        case .dataQuality:
            .unsupported("Data-quality status and score are available on web.")
        }
    }

    static func detail(_ renderer: DetailRendererID) -> Status {
        switch renderer {
        case .expenseProject,
            .ownerLedgerPartyId,
            .ownershipMode,
            .productCategory,
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
        case .effectiveOwnership, .imageCaptureLocation:
            // `imageCaptureLocation` is `ImageEntityDetailView`'s own Provenance map row, not a
            // generic renderer — Image never uses the generic detail view (`image.detail`, not
            // `resources.image.get`; see this file's own doc comment), so this case can only be
            // reached defensively, but the dedicated screen already covers it.
            .ownedElsewhere
        case .productCategoryPath,
            .financialAccountIdentity,
            .financialAccountSourceAliases,
            .financialAccountCardNumbers,
            .financialTransactionSourceRefs,
            .financialTransactionVendorInference,
            .ledgerTransferClassification,
            .recipeMeta,
            .recipeSections,
            .recipeTotals,
            .vendorAgentHints,
            .wishCandidates,
            .recipeYield,
            .imageSightingLocation,
            .imageSightingCamera,
            .imageProvenanceEvidence:
            .unsupported("This structured detail is available on web.")
        }
    }

    /// Hero actions are declaration-owned verbs. `edit` stays in the screen toolbar; every
    /// other declared hero verb currently has a web implementation only. Add a native handler
    /// and mark its verb implemented together when one becomes available.
    static func heroAction(_ action: EntityHeroActionID) -> Status {
        switch action {
        case .edit:
            .ownedElsewhere
        case .addToInventory, .bulkEdit, .delete, .discard, .markPurchased, .recordSale, .setStatus:
            .unsupported("This action is available on web.")
        }
    }

    /// Detail slots are entity-qualified in the generated catalog. Keep every declared id in
    /// this switch, including slots that currently have no native body, so an unqualified id or
    /// a newly copied slot cannot accidentally select the wrong entity's implementation.
    static func detailSlot(_ id: String) -> Status {
        guard let id = EntityDetailSlotID(rawValue: id) else {
            return .unsupported("Unknown native detail slot.")
        }
        return switch id {
        case .ledgerPartyWardrobe, .mealNutrition:
            .implemented
        case .productLabels,
            .productNutrition,
            .productUnitMappings,
            .productFitsWith,
            .productCookbooks,
            .productRecipeAppearances,
            .productImportRuns,
            .recipeWorkflow,
            .ingredientNutritionProduct,
            .cookbookToc,
            .cookbookImportProgress,
            .locationContentsValuation,
            .locationAiDescription,
            .mealComposition,
            .projectBudget,
            .projectContribution,
            .projectAnalytics,
            .purchaseProjectAllocation,
            .purchaseImportRuns,
            .purchaseReconciliation,
            .purchaseFinancialSettlement,
            .expenseSettlement,
            .imageAssociations,
            .importRunImportWorkflow,
            .importRunPhotoBatch,
            .importRunAiUsage,
            .importRunChanges:
            .unsupported("This detail is available on web.")
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
            "productCategory.hierarchy",
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

    static func unsupportedHeroAction(_ action: EntityHeroActionID) -> String? {
        guard case .unsupported(let reason) = heroAction(action) else { return nil }
        return reason
    }
}
