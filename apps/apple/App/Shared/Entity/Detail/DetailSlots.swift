import CubbyKit
import SwiftUI

/// Which declared detail slots native fills, and which entity-specific supplements appear.
/// Unsupported declaration features are surfaced by the detail screen. The slot ids are
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
            return reportSlot(.product_runs, row)
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
            return reportSlot(.ingredient_recipeUsages, row)
        case .cookbookToc:
            return AnyView(
                CookbookContentsSlot(
                    cookbookID: row.id,
                    hasReadableExtraction: row.raw["needsReextract"]?.boolValue != true))
        case .cookbookImportProgress:
            return AnyView(CookbookImportProgressSlot(row: row))
        case .mealComposition:
            return reportSlot(.meal_composition, row)
        case .projectBudget:
            return reportSlot(.project_budget, row)
        case .projectContribution:
            return reportSlot(.project_contribution, row)
        case .projectAnalytics:
            return reportSlot(.project_analytics, row)
        case .projectSchedule:
            return reportSlot(.project_schedule, row)
        case .locationContentsValuation:
            return reportSlot(.location_contentsValuation, row)
        case .emailReview:
            return reportSlot(.email_review, row)
        case .productLabels:
            return reportSlot(.product_labels, row)
        case .productCookbooks:
            return reportSlot(.product_cookbooks, row)
        case .productRecipeAppearances:
            return reportSlot(.product_recipeAppearances, row)
        case .imageAssociations:
            return reportSlot(.image_associations, row)
        case .imageJobAttempts:
            return reportSlot(.imageJob_attempts, row)
        case .purchaseRuns:
            return reportSlot(.purchase_runs, row)
        case .locationAiDescription:
            return reportSlot(.location_aiDescription, row)
        case .purchaseReconciliation:
            return reportSlot(.purchase_reconciliation, row)
        case .purchaseProjectAllocation:
            return reportSlot(.purchase_projectAllocation, row)
        case .purchaseFinancialSettlement:
            return reportSlot(.purchase_financialSettlement, row)
        case .expenseSettlement:
            return reportSlot(.expense_settlement, row)
        case .vendorSpendingClassification:
            return AnyView(SpendingClassificationView(key: .vendor, row: row))
        case .productCategorySpendingClassification:
            return AnyView(SpendingClassificationView(key: .productCategory, row: row))
        case .purchaseReceiving:
            return AnyView(PurchaseReceivingSlot(purchaseID: row.id))
        case .runLiveProgress:
            return runReportSlot(.run_liveProgress, row, imports: false)
        case .runImportStats:
            return runReportSlot(.run_importStats, row)
        case .runImportProgressLive:
            return runReportSlot(.run_importProgressLive, row, liveness: true)
        case .runImportProgressStopped:
            return runReportSlot(.run_importProgressStopped, row, liveness: false)
        case .runImportPurchases:
            return runReportSlot(.run_importPurchases, row)
        case .runImportApprovals:
            return runReportSlot(.run_importApprovals, row)
        case .runImportFindings:
            return runReportSlot(.run_importFindings, row)
        case .runImportTargets:
            return runReportSlot(.run_importTargets, row)
        case .runImportPreparedOrders:
            return runReportSlot(.run_importPreparedOrders, row)
        case .runImportTimeline:
            return runReportSlot(.run_importTimeline, row)
        case .runImportDebugLog:
            return runReportSlot(.run_importDebugLog, row)
        case .runAiUsage:
            return runReportSlot(.run_aiUsage, row, imports: false)
        case .runSuggestions:
            return runReportSlot(.run_suggestions, row, imports: false)
        case .runChanges:
            return runReportSlot(.run_changes, row, imports: false)
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
        guard let slot = ImplementedDetailSlotID(rawValue: slot) else { return nil }
        return build(slot, row)
    }

    /// Record-specific affordances beside the generic sections; none is a manifest hero action.
    @MainActor
    static func supplement(for key: EntityKey, row: EntityRow, onChanged: @escaping () -> Void) -> AnyView? {
        switch key {
        case .expense:
            guard let productID = row.raw["productId"]?.stringValue else { return nil }
            return AnyView(ReceiveExpenseButton(expenseID: row.id, productID: productID))
        case .financialTransaction:
            return AnyView(FinancialTransactionEvidenceView(row: row, onChanged: onChanged))
        default:
            return nil
        }
    }
}

private struct ProductJourneySummaryView: View {
    let product: ProductDetail
    @Environment(AppModel.self) private var appModel

    private var ownPhotos: Int { product.attachments.filter { $0.source == .own }.count }

    var body: some View {
        VStack(alignment: .leading, spacing: FieldGuideTokens.Space.xs) {
            Text(
                product.ownershipEvidence.state == .exited
                    ? "Recorded ownership ended\(product.ownershipEvidence.exitedAt.map { " on \($0.rawValue)" } ?? "")."
                    : product.ownershipEvidence.state == .owned
                        ? "Recorded movements establish ownership."
                        : "Ownership is uncertain: recorded movements do not establish the current quantity."
            )
            .font(.subheadline)
            if product.ownershipEvidence.state != .exited {
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
                Link(
                    "Review purchase and statement",
                    destination: appModel.webURL(for: .product, id: product.id.rawValue))
            }
        }
        .font(.caption)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.top, FieldGuideTokens.Space.xs)
    }
}

/// `run.import-controls` for a paused import: the Run is paused, and web holds the controls that
/// resume or stop it. Approval pauses are answered in `run.import-approvals` instead.
private struct RunPausedHandoff: View {
    static let pausedStatuses: Set<String> = ["paused_auth", "paused_offline"]

    let runID: String
    @Environment(AppModel.self) private var appModel

    var body: some View {
        VStack(alignment: .leading, spacing: FieldGuideTokens.Space.xs) {
            Label("Run paused", systemImage: "pause.circle")
                .font(.subheadline.weight(.medium))
            Link("Open run controls", destination: appModel.webURL(for: .run, id: runID))
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
