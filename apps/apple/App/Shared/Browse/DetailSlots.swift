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
        .productRuns: { AnyView(ProductEnrichmentHistorySlot(productID: $0.id)) },
        .productOwnership: { row in
            guard let detail = try? row.decode(ProductDetail.self) else { return nil }
            return AnyView(ProductJourneySummaryView(product: detail))
        },
        .mealNutrition: { AnyView(MealNutritionSlot(mealID: $0.id)) },
        .recipeWorkflow: { AnyView(RecipeWorkflowDetailSlot(row: $0)) },
        .ingredientNutritionProduct: { AnyView(IngredientNutritionProductSlot(row: $0)) },
        .ingredientRecipeUsages: { AnyView(IngredientRecipeUsagesSlot(row: $0)) },
        .cookbookToc: { AnyView(CookbookContentsSlot(cookbookID: $0.id)) },
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
        .ledgerPartyWardrobe: { AnyView(WardrobeDetailSlot(ownerID: $0.id, ownerName: $0.title)) },
        .vendorOrderMail: { AnyView(OrderMailDetailSlot(scope: .vendor($0.id, nil))) },
        .vendorSpendingClassification: { AnyView(SpendingClassificationView(key: .vendor, row: $0)) },
        .productCategorySpendingClassification: {
            AnyView(SpendingClassificationView(key: .productCategory, row: $0))
        },
        .vendorAccountOrderMail: { row in
            guard let vendorID = row.raw["vendorId"]?.stringValue else { return nil }
            return AnyView(
                OrderMailDetailSlot(
                    scope: .vendor(vendorID, row.raw["ledgerPartyId"]?.stringValue)))
        },
        .purchaseReceiving: { AnyView(PurchaseReceivingSlot(purchaseID: $0.id)) },
        .purchaseOrderMail: { AnyView(OrderMailDetailSlot(scope: .purchase($0.id))) },
        .runImportControls: { row in
            guard row.raw["purpose"]?.stringValue != "photo_inventory" else { return nil }
            return AnyView(
                NavigationLink {
                    RunReviewView(runID: row.id)
                } label: {
                    Label("Open live run", systemImage: "arrow.up.right.square")
                })
        },
        .runPhotoBatch: { row in
            guard row.raw["purpose"]?.stringValue == "photo_inventory" else { return nil }
            return AnyView(
                NavigationLink {
                    RunReviewView(runID: row.id)
                } label: {
                    Label("Review photos and items", systemImage: "photo.on.rectangle")
                })
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
                    failure(message, nutrition)
                case .loaded(let summary):
                    MealNutritionPeopleView(summary: summary)
                }
                if let error = nutrition.refreshError, case .loaded = nutrition.state {
                    failure(error, nutrition)
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

    private func failure(_ message: String, _ nutrition: MealNutritionModel) -> some View {
        VStack(alignment: .leading, spacing: FieldGuideTokens.Space.sm) {
            Text(message).font(.callout).foregroundStyle(.secondary)
            if nutrition.isLoading { LoadingIndicator(label: "Retrying") }
            Button("Retry") { Task { await nutrition.refresh() } }.disabled(nutrition.isLoading)
        }
    }
}
