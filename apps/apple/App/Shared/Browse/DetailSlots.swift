import CubbyKit
import SwiftUI

/// The one sanctioned `switch (key, id)` in the App: which declared detail slots and hero verbs
/// native fills. Unsupported declared slots are surfaced once by the detail screen rather than
/// disappearing silently; a verb it does not know is not offered.
enum DetailSlotRegistry {
    /// Section content for `slot` on `key`'s detail; nil renders nothing (the section is skipped).
    @MainActor
    static func view(for key: EntityKey, slot: String, row: EntityRow, appModel: AppModel) -> AnyView? {
        switch (key, slot) {
        case (.meal, "meal.nutrition"):
            AnyView(MealNutritionSlot(mealID: row.id))
        case (.ledgerParty, "ledgerParty.wardrobe"):
            AnyView(WardrobeDetailSlot(ownerID: row.id, ownerName: row.title))
        default:
            nil
        }
    }

    /// The hero action row for the verbs `declared` on `key`'s presentation, minus `edit`
    /// (the toolbar's); nil when none of the declared verbs has a native handler. No entity
    /// currently declares a hero verb beyond the default `edit`, so this always returns nil —
    /// kept as the registration point for the next one that does.
    @MainActor
    static func heroActions(
        for key: EntityKey, declared: [String], row: EntityRow, onChanged: @escaping () -> Void
    ) -> AnyView? {
        switch key {
        case .inventory:
            guard let detail = try? row.decode(InventoryDetail.self) else { return nil }
            return AnyView(InventoryOwnershipControl(detail: detail, onChanged: onChanged))
        default:
            return nil
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
