import CubbyKit
import SwiftUI

/// The one sanctioned `switch (key, id)` in the App: which declared detail slots native fills and
/// which entity-specific supplements appear. Unsupported declaration features are surfaced by
/// the detail screen.
enum DetailSlotRegistry {
    /// Section content for `slot` on `key`'s detail; nil renders nothing (the section is skipped).
    @MainActor
    static func view(for key: EntityKey, slot: String, row: EntityRow, appModel: AppModel) -> AnyView? {
        guard let slot = EntityDetailSlotID(rawValue: slot) else { return nil }
        switch (key, slot) {
        case (.meal, .mealNutrition):
            return AnyView(MealNutritionSlot(mealID: row.id))
        case (.ledgerParty, .ledgerPartyWardrobe):
            return AnyView(WardrobeDetailSlot(ownerID: row.id, ownerName: row.title))
        case (.importRun, .importRunImportWorkflow)
        where row.raw["purpose"]?.stringValue != "photo_inventory":
            return AnyView(
                NavigationLink {
                    ImportRunReviewView(runID: row.id)
                } label: {
                    Label("Open live run", systemImage: "arrow.up.right.square")
                })
        case (.importRun, .importRunPhotoBatch)
        where row.raw["purpose"]?.stringValue == "photo_inventory":
            return AnyView(
                NavigationLink {
                    ImportRunReviewView(runID: row.id)
                } label: {
                    Label("Review photos and items", systemImage: "photo.on.rectangle")
                })
        default:
            return nil
        }
    }

    /// Ownership is a dedicated, evidence-aware inventory affordance. It is not a manifest hero
    /// action and must remain available when the manifest declares no native hero verb.
    @MainActor
    static func supplement(for key: EntityKey, row: EntityRow, onChanged: @escaping () -> Void) -> AnyView? {
        switch key {
        case .inventory:
            guard let detail = try? row.decode(InventoryDetail.self) else { return nil }
            return AnyView(InventoryOwnershipControl(detail: detail, onChanged: onChanged))
        case .product:
            guard let detail = try? row.decode(ProductDetail.self) else { return nil }
            return AnyView(ProductJourneySummaryView(product: detail))
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
        VStack(alignment: .leading, spacing: PorcelainTokens.Space.xs) {
            Text("Finish this item").font(.subheadline.weight(.semibold))
            Label(
                ownPhotos == 0 ? "Add an item photo" : "\(ownPhotos) own photos",
                systemImage: ownPhotos == 0 ? "circle.dotted" : "checkmark.circle.fill"
            )
            Label(
                product.inventoryEntry.isEmpty ? "Record where it lives" : "Inventory recorded",
                systemImage: product.inventoryEntry.isEmpty ? "circle.dotted" : "checkmark.circle.fill"
            )
            Link(
                "Review purchase and statement",
                destination: appModel.webURL(for: .product, id: product.id.rawValue))
        }
        .font(.caption)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.top, PorcelainTokens.Space.xs)
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
        VStack(alignment: .leading, spacing: PorcelainTokens.Space.sm) {
            Text(message).font(.callout).foregroundStyle(.secondary)
            if nutrition.isLoading { LoadingIndicator(label: "Retrying") }
            Button("Retry") { Task { await nutrition.refresh() } }.disabled(nutrition.isLoading)
        }
    }
}
