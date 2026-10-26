import CubbyKit
import SwiftUI

/// Which declared detail slots native fills, and which entity-specific supplements appear.
/// A `handoff` slot draws its `OpenOnWebButton` row in the section. The slot ids are
/// entity-qualified, so no `(entity, slot)` pairing is needed.
enum DetailSlotRegistry {
    /// One case per slot `packages/schemas/src/native-coverage.ts` marks `implemented`, so a
    /// declaration without a view, or a view for a slot that is not implemented, fails to compile.
    /// A slot may still return nil for a row it does not apply to (the section is then skipped).
    @MainActor
    private static func build(_ slot: ImplementedDetailSlotID, _ row: EntityRow) -> AnyView? {
        switch slot {
        case .productNutrition:
            return AnyView(ProductNutritionDetailSlot(row: row))
        case .productUnitMappings:
            return AnyView(ProductUnitMappingsDetailSlot(row: row))
        case .productFitsWith:
            return AnyView(ProductSimilarityDetailSlot(productID: row.id))
        case .productRuns:
            return reportSlot(.productRuns, row)
        case .productOwnership:
            guard let detail = try? row.decode(ProductDetail.self) else { return nil }
            return AnyView(ProductJourneySummaryView(product: detail))
        case .mealNutrition:
            return AnyView(MealNutritionSlot(mealID: row.id))
        case .recipeWorkflow:
            return AnyView(RecipeWorkflowDetailSlot(row: row))
        case .ingredientNutritionProduct:
            return AnyView(IngredientNutritionProductSlot(row: row))
        case .ingredientRecipeUsages:
            return reportSlot(.ingredientRecipeUsages, row)
        case .cookbookToc:
            return AnyView(
                CookbookContentsSlot(
                    cookbookID: row.id,
                    hasReadableExtraction: row.raw["needsReextract"]?.boolValue != true))
        case .cookbookImportProgress:
            return AnyView(CookbookImportProgressSlot(row: row))
        case .mealComposition:
            return reportSlot(.mealComposition, row)
        case .projectBudget:
            return reportSlot(.projectBudget, row)
        case .projectContribution:
            return reportSlot(.projectContribution, row)
        case .projectAnalytics:
            return reportSlot(.projectAnalytics, row)
        case .projectSchedule:
            return reportSlot(.projectSchedule, row)
        case .locationContentsValuation:
            return reportSlot(.locationContentsValuation, row)
        case .vendorMailSearch:
            return reportSlot(.vendorMailSearch, row)
        case .emailReview:
            return reportSlot(.emailReview, row)
        case .productLabels:
            return reportSlot(.productLabels, row)
        case .productCookbooks:
            return reportSlot(.productCookbooks, row)
        case .productRecipeAppearances:
            return reportSlot(.productRecipeAppearances, row)
        case .imageAssociations:
            return reportSlot(.imageAssociations, row)
        case .imageJobAttempts:
            return reportSlot(.imageJobAttempts, row)
        case .shipmentTracking:
            return reportSlot(.shipmentTracking, row)
        case .purchaseRuns:
            return reportSlot(.purchaseRuns, row)
        case .locationAiDescription:
            return reportSlot(.locationAiDescription, row)
        case .purchaseProjectAllocation:
            return reportSlot(.purchaseProjectAllocation, row)
        case .purchaseFinancialSettlement:
            return reportSlot(.purchaseFinancialSettlement, row)
        case .purchaseReceiving:
            return AnyView(PurchaseReceivingSlot(purchaseID: row.id))
        case .runSteps:
            return runReportSlot(.runSteps, row, imports: false)
        case .runResults:
            return runReportSlot(.runResults, row, imports: false)
        case .runLiveProgress:
            return runReportSlot(.runLiveProgress, row, imports: false)
        case .runImportStats:
            return runReportSlot(.runImportStats, row)
        case .runImportProgressLive:
            return runReportSlot(.runImportProgressLive, row, liveness: true)
        case .runImportProgressStopped:
            return runReportSlot(.runImportProgressStopped, row, liveness: false)
        case .runImportPurchases:
            return runReportSlot(.runImportPurchases, row)
        case .runImportFindings:
            return runReportSlot(.runImportFindings, row)
        case .runImportTargets:
            return runReportSlot(.runImportTargets, row)
        case .runImportPreparedOrders:
            return runReportSlot(.runImportPreparedOrders, row)
        case .runImportTimeline:
            return runReportSlot(.runImportTimeline, row)
        case .runImportDebugLog:
            return runReportSlot(.runImportDebugLog, row)
        case .runAiUsage:
            return runReportSlot(.runAiUsage, row, imports: false)
        case .runSuggestions:
            return runReportSlot(.runSuggestions, row, imports: false)
        case .runDecisions:
            return runReportSlot(.runDecisions, row, imports: false)
        case .runDiagnostics:
            return runReportSlot(.runDiagnostics, row, imports: false)
        case .runChanges:
            return runReportSlot(.runChanges, row, imports: false)
        // Native has no control command (resume and stop are web's), so a paused import says so
        // and hands off to web; other states have nothing to show.
        case .runImportControls:
            guard SharedConstants.importReportRunPurposes.contains(row.raw["purpose"]?.stringValue ?? ""),
                RunPausedHandoff.pausedStatuses.contains(row.raw["status"]?.stringValue ?? "")
            else { return nil }
            return AnyView(RunPausedHandoff(runID: row.id))
        case .runPhotoBatch:
            guard row.raw["purpose"]?.stringValue == "photo_inventory" else { return nil }
            return AnyView(RunPhotoBatchSlot(runID: row.id))
        }
    }

    /// The server-composed report slots share one generic view; the row id is the record's code.
    @MainActor
    private static func reportSlot(_ slot: ReportSlot, _ row: EntityRow) -> AnyView {
        // The slot id's first segment is the record's entity (`product.labels`).
        let entity = slot.rawValue.split(separator: ".").first.flatMap { EntityKey(rawValue: String($0)) }
        return AnyView(
            ReportDetailSlot(slot: slot, id: row.id, host: entity.map { ReportHost(entity: $0, row: row) }))
    }

    /// A run's report slot; nil (the section is skipped) when the run does not take it. The
    /// import slots follow shared report presentation, independently of execution capability. Live and stopped progress
    /// variants split on whether the run is still moving; the server enforces the same rules.
    @MainActor
    private static func runReportSlot(
        _ slot: ReportSlot, _ row: EntityRow, imports: Bool = true, liveness: Bool? = nil
    ) -> AnyView? {
        if imports,
            !SharedConstants.importReportRunPurposes.contains(row.raw["purpose"]?.stringValue ?? "")
        {
            return nil
        }
        let status = row.raw["status"]?.stringValue
        if let liveness, liveness != SharedConstants.activeRunStatuses.contains(status ?? "") {
            return nil
        }
        return AnyView(ReportDetailSlot(slot: slot, id: row.id, shownStatus: status))
    }

    /// Section content for `slot` on a detail screen; nil renders nothing (the section is skipped).
    @MainActor
    static func view(slot: String, row: EntityRow) -> AnyView? {
        if let implemented = ImplementedDetailSlotID(rawValue: slot) { return build(implemented, row) }
        guard let handoff = handoff(slot: slot, row: row),
            let key = slot.split(separator: ".").first.flatMap({ EntityKey(rawValue: String($0)) })
        else { return nil }
        return handoffRow(handoff.label, target: handoff.target(key: key, id: row.id), id: slot)
    }

    /// The one row a web handoff draws where the native surface would have stood.
    @MainActor
    private static func handoffRow(_ label: String, target: WebHandoff.Target, id: String) -> AnyView {
        AnyView(
            OpenOnWebButton(target: target) {
                HStack {
                    Label(label, systemImage: "safari")
                    Spacer(minLength: FieldGuideTokens.Space.sm)
                    Image(systemName: "arrow.up.right").foregroundStyle(.secondary).accessibilityHidden(true)
                }
                .contentShape(Rectangle())
            }
            .accessibilityIdentifier("detail.handoff.\(id)"))
    }

    /// Transaction kinds web can book into the Expense ledger (`financialTransaction.previewBooking`).
    private static let bookableKinds: Set<String> = [
        "purchase", "refund", "adjustment", "fee", "interest", "income",
    ]

    /// The web handoff a `handoff` slot draws for `row`; nil when the slot is native or, like web's
    /// slot predicate, does not apply to the row.
    static func handoff(slot: String, row: EntityRow) -> NativeWebHandoff? {
        guard let handoff = NativePresentationCoverage.detailSlot(slot).handoff else { return nil }
        switch slot {
        // Import runs only; live and stopped split on whether the run is still moving, as the
        // import progress slots do.
        case "run.import-agent-live", "run.import-agent-stopped":
            guard SharedConstants.importReportRunPurposes.contains(row.raw["purpose"]?.stringValue ?? "")
            else { return nil }
            let live = SharedConstants.activeRunStatuses.contains(row.raw["status"]?.stringValue ?? "")
            return live == (slot == "run.import-agent-live") ? handoff : nil
        default:
            return handoff
        }
    }

    /// Record-specific affordances beside the generic sections; none is a manifest hero action.
    @MainActor
    static func supplement(for key: EntityKey, row: EntityRow) -> AnyView? {
        switch key {
        case .expense:
            guard let productID = row.raw["productId"]?.stringValue else { return nil }
            return AnyView(ReceiveExpenseButton(expenseID: row.id, productID: productID))
        // Booking a charge into the Expense ledger, and correcting a recorded booking, are web's:
        // both sit with the allocations in the transaction's Record section.
        case .financialTransaction:
            guard row.raw["status"]?.stringValue != "void",
                bookableKinds.contains(row.raw["kind"]?.stringValue ?? "")
            else { return nil }
            return handoffRow(
                "Review booking on web",
                target: .record(key: .financialTransaction, id: row.id, section: "overview"),
                id: "financialTransaction.booking")
        default:
            return nil
        }
    }
}

private struct ProductJourneySummaryView: View {
    let product: ProductDetail

    private var ownPhotos: Int { product.attachments.filter { $0.source == .own }.count }
    private var isService: Bool {
        product.category?.feature == .services || product.category?.feature == .software
    }

    var body: some View {
        VStack(alignment: .leading, spacing: FieldGuideTokens.Space.xs) {
            Text(
                isService
                    ? "Actual Expenses record charge history; bill amounts may vary."
                    : product.ownershipEvidence.state == .exited
                        ? "Recorded ownership ended\(product.ownershipEvidence.exitedAt.map { " on \($0.rawValue)" } ?? "")."
                        : product.ownershipEvidence.state == .owned
                            ? "Recorded movements establish ownership."
                            : "Ownership is uncertain: recorded movements do not establish the current quantity."
            )
            .font(.subheadline)
            if !isService && product.ownershipEvidence.state != .exited {
                Label(
                    ownPhotos == 0 ? "Add an item photo" : "\(ownPhotos) own photos",
                    systemImage: ownPhotos == 0 ? "circle.dotted" : "checkmark.circle.fill"
                )
                Label(
                    (product.onHandUnits ?? 0) <= 0
                        ? product.ownershipEvidence.state == .uncertain
                            ? "Confirm whether you still own it before recording stock"
                            : "Record where it lives"
                        : "Inventory recorded",
                    systemImage: (product.onHandUnits ?? 0) <= 0 ? "circle.dotted" : "checkmark.circle.fill"
                )
            }
            if isService || product.ownershipEvidence.state != .exited {
                OpenOnWebButton(
                    target: .record(key: .product, id: product.id.rawValue),
                    label: "Review purchase and statement on web")
            }
        }
        .font(.caption)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.top, FieldGuideTokens.Space.xs)
    }
}

/// `run.import-controls` for a paused import: the Run is paused, and web holds the controls that
/// resume or stop it.
private struct RunPausedHandoff: View {
    static let pausedStatuses: Set<String> = ["paused", "paused_auth", "paused_offline"]

    let runID: String

    var body: some View {
        VStack(alignment: .leading, spacing: FieldGuideTokens.Space.xs) {
            Label("Run paused", systemImage: "pause.circle")
                .font(.subheadline.weight(.medium))
            OpenOnWebButton(
                target: .record(key: .run, id: runID, section: "import-controls"),
                label: "Open run controls on web")
        }
    }
}

/// `meal.nutrition`: the per-person macro summary from `meal.nutrition` for one meal.
private struct MealNutritionSlot: View {
    let mealID: String
    @Environment(AppModel.self) private var appModel
    @State private var nutrition: MealNutritionModel?

    var body: some View {
        Group {
            if let nutrition {
                switch nutrition.state {
                case .loading:
                    LoadingIndicator(label: "Loading nutrition")
                case .failed(let message):
                    InlineLoadFailure(message: message, isRetrying: nutrition.isLoading) {
                        await nutrition.refresh()
                    }
                case .loaded(let summary):
                    MealNutritionPeopleView(summary: summary)
                }
                if let error = nutrition.refreshError, case .loaded = nutrition.state {
                    InlineLoadFailure(message: error, isRetrying: nutrition.isLoading) {
                        await nutrition.refresh()
                    }
                }
            } else {
                LoadingIndicator(label: "Loading nutrition")
            }
        }
        .task(id: mealID) {
            let model = MealNutritionModel(query: .meal(mealID), client: appModel.client)
            nutrition = model
            await model.refresh()
        }
        .task(id: appModel.entityMutationRevision) {
            guard appModel.entityMutationRevision > 0, appModel.entityMutationKeys.contains(.meal)
            else { return }
            await nutrition?.refresh()
        }
    }

}
