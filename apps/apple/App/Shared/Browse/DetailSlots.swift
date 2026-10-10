import CubbyKit
import SwiftUI

/// Which declared detail slots native fills, and which entity-specific supplements appear.
/// Unsupported declaration features are surfaced by the detail screen. The slot ids are
/// entity-qualified, so no `(entity, slot)` pairing is needed.
enum DetailSlotRegistry {
    typealias Builder = @MainActor (_ row: EntityRow) -> AnyView?

    /// Exactly the slots `packages/schemas/src/native-coverage.ts` marks `implemented`;
    /// `NativeCoverageViewPathTests` fails when the two sets differ. A builder may still return
    /// nil for a row it does not apply to (the section is then skipped).
    @MainActor
    static let builders: [EntityDetailSlotID: Builder] = [
        .productNutrition: { AnyView(ProductNutritionDetailSlot(row: $0)) },
        .productUnitMappings: { AnyView(ProductUnitMappingsDetailSlot(row: $0)) },
        .productFitsWith: { AnyView(ProductSimilarityDetailSlot(productID: $0.id)) },
        .productRuns: { reportSlot(.product_runs, $0) },
        .productOwnership: { row in
            guard let detail = try? row.decode(ProductDetail.self) else { return nil }
            return AnyView(ProductJourneySummaryView(product: detail))
        },
        .mealNutrition: { AnyView(MealNutritionSlot(mealID: $0.id)) },
        .recipeWorkflow: { AnyView(RecipeWorkflowDetailSlot(row: $0)) },
        .ingredientNutritionProduct: { AnyView(IngredientNutritionProductSlot(row: $0)) },
        .ingredientRecipeUsages: { reportSlot(.ingredient_recipeUsages, $0) },
        .cookbookToc: { row in
            AnyView(
                CookbookContentsSlot(
                    cookbookID: row.id,
                    hasReadableExtraction: row.raw["needsReextract"]?.boolValue != true))
        },
        .cookbookImportProgress: { AnyView(CookbookImportProgressSlot(row: $0)) },
        .mealComposition: { reportSlot(.meal_composition, $0) },
        .projectBudget: { reportSlot(.project_budget, $0) },
        .projectContribution: { reportSlot(.project_contribution, $0) },
        .projectAnalytics: { reportSlot(.project_analytics, $0) },
        .projectSchedule: { reportSlot(.project_schedule, $0) },
        .locationContentsValuation: { reportSlot(.location_contentsValuation, $0) },
        .productLabels: { reportSlot(.product_labels, $0) },
        .productCookbooks: { reportSlot(.product_cookbooks, $0) },
        .productRecipeAppearances: { reportSlot(.product_recipeAppearances, $0) },
        .imageAssociations: { reportSlot(.image_associations, $0) },
        .purchaseRuns: { reportSlot(.purchase_runs, $0) },
        .locationAiDescription: { reportSlot(.location_aiDescription, $0) },
        .purchaseReconciliation: { reportSlot(.purchase_reconciliation, $0) },
        .purchaseProjectAllocation: { reportSlot(.purchase_projectAllocation, $0) },
        .purchaseFinancialSettlement: { reportSlot(.purchase_financialSettlement, $0) },
        .expenseSettlement: { reportSlot(.expense_settlement, $0) },
        .vendorAccountSync: { reportSlot(.vendorAccount_sync, $0) },
        .vendorAccountChargeSearch: { reportSlot(.vendorAccount_chargeSearch, $0) },
        .ledgerPartyWardrobe: { AnyView(WardrobeDetailSlot(ownerID: $0.id, ownerName: $0.title)) },
        .vendorOrderMail: { reportSlot(.vendor_orderMail, $0) },
        .vendorSpendingClassification: { AnyView(SpendingClassificationView(key: .vendor, row: $0)) },
        .productCategorySpendingClassification: {
            AnyView(SpendingClassificationView(key: .productCategory, row: $0))
        },
        .vendorAccountOrderMail: { reportSlot(.vendorAccount_orderMail, $0) },
        .purchaseReceiving: { AnyView(PurchaseReceivingSlot(purchaseID: $0.id)) },
        .purchaseOrderMail: { reportSlot(.purchase_orderMail, $0) },
        .runLiveProgress: { runReportSlot(.run_liveProgress, $0, imports: false) },
        .runImportStats: { runReportSlot(.run_importStats, $0) },
        .runImportProgressLive: { runReportSlot(.run_importProgressLive, $0, liveness: true) },
        .runImportProgressStopped: { runReportSlot(.run_importProgressStopped, $0, liveness: false) },
        .runImportPurchases: { runReportSlot(.run_importPurchases, $0) },
        .runImportApprovals: { runReportSlot(.run_importApprovals, $0) },
        .runImportFindings: { runReportSlot(.run_importFindings, $0) },
        .runImportTargets: { runReportSlot(.run_importTargets, $0) },
        .runImportEvidence: { runReportSlot(.run_importEvidence, $0) },
        .runImportPreparedOrders: { runReportSlot(.run_importPreparedOrders, $0) },
        .runImportTimeline: { runReportSlot(.run_importTimeline, $0) },
        .runImportDebugLog: { runReportSlot(.run_importDebugLog, $0) },
        .runAiUsage: { runReportSlot(.run_aiUsage, $0, imports: false) },
        .runChanges: { runReportSlot(.run_changes, $0, imports: false) },
        // Native has no control command (pause, resume and stop are web's), so a paused import
        // says what it waits for and hands off to web; other states have nothing to show.
        .runImportControls: { row in
            guard SharedConstants.importReportRunPurposes.contains(row.raw["purpose"]?.stringValue ?? ""),
                let paused = RunPausedHandoff.Reason(rawValue: row.raw["status"]?.stringValue ?? "")
            else { return nil }
            return AnyView(RunPausedHandoff(runID: row.id, reason: paused))
        },
        .runPhotoBatch: { row in
            guard row.raw["purpose"]?.stringValue == "photo_inventory" else { return nil }
            return AnyView(RunPhotoBatchSlot(runID: row.id))
        },
    ]

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
        guard let slot = EntityDetailSlotID(rawValue: slot) else { return nil }
        return builders[slot]?(row)
    }

    /// Ownership is a dedicated, evidence-aware inventory affordance. It is not a manifest hero
    /// action and must remain available when the manifest declares no native hero verb.
    @MainActor
    static func supplement(for key: EntityKey, row: EntityRow, onChanged: @escaping () -> Void) -> AnyView? {
        switch key {
        case .inventory:
            guard let detail = try? row.decode(InventoryDetail.self) else { return nil }
            return AnyView(InventoryOwnershipControl(detail: detail, onChanged: onChanged))
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

/// `run.import-controls` for a paused import: what the Run waits for, and the web controls that
/// resume it.
private struct RunPausedHandoff: View {
    enum Reason: String {
        case pausedAuth = "paused_auth"
        case pausedOffline = "paused_offline"
    }

    let runID: String
    let reason: Reason
    @Environment(AppModel.self) private var appModel

    var body: some View {
        VStack(alignment: .leading, spacing: FieldGuideTokens.Space.xs) {
            Label(
                reason == .pausedAuth ? "Waiting for retailer sign-in" : "Waiting for Mac browser",
                systemImage: "person.crop.circle.badge.clock"
            )
            .font(.subheadline.weight(.medium))
            Text(
                reason == .pausedAuth
                    ? "Finish sign-in in the Cubby-managed Chrome tab on your Mac, then resume this run."
                    : "Reconnect the Cubby Mac browser and leave the retailer tab open before resuming."
            )
            .font(.caption).foregroundStyle(.secondary)
            Link("Open sign-in and resume controls", destination: appModel.webURL(for: .run, id: runID))
        }
    }
}

private struct WardrobeDetailSlot: View {
    let ownerID: String
    let ownerName: String

    var body: some View {
        NavigationLink(value: Route.wardrobe(ownerID: ownerID, ownerName: ownerName)) {
            Label("Browse wardrobe", systemImage: "tshirt")
        }
        .accessibilityIdentifier("detail.ledgerParty.wardrobe")
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
