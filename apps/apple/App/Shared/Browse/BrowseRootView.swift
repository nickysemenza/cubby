import CubbyKit
import SwiftUI

/// Every entity in `EntityCatalog`, grouped by whether Browse can list it. Static — no network
/// call, since the catalog itself already carries plural names, base paths, and actions.
struct BrowseRootView: View {
    @State private var query = ""

    private var browsable: [EntityDescriptor] {
        matching(EntityCatalog.all.filter { $0.actions.contains(.list) })
    }

    private var unbrowsable: [EntityDescriptor] {
        matching(EntityCatalog.all.filter { !$0.actions.contains(.list) })
    }

    var body: some View {
        List {
            if !browsable.isEmpty {
                Section("Browsable") {
                    ForEach(browsable, id: \.key) { descriptor in
                        NavigationLink(value: Route.entityList(descriptor.key)) {
                            Label(descriptor.plural, systemImage: entitySymbol(for: descriptor.key))
                        }
                    }
                }
            }
            if !unbrowsable.isEmpty {
                Section("No list route") {
                    ForEach(unbrowsable, id: \.key) { descriptor in
                        VStack(alignment: .leading, spacing: 2) {
                            Label(descriptor.plural, systemImage: entitySymbol(for: descriptor.key))
                                .foregroundStyle(PorcelainTokens.graphiteSecondary)
                            Text("No list route for \(descriptor.plural)")
                                .font(.footnote)
                                .foregroundStyle(PorcelainTokens.graphiteSecondary)
                        }
                        .disabled(true)
                    }
                }
            }
        }
        .navigationTitle("Browse")
        .searchable(text: $query)
    }

    private func matching(_ descriptors: [EntityDescriptor]) -> [EntityDescriptor] {
        guard !query.isEmpty else { return descriptors }
        return descriptors.filter { $0.plural.localizedCaseInsensitiveContains(query) }
    }
}

/// SF Symbol per entity key, used by Browse rows and by `EntityListView`'s empty/loading states.
/// Falls back to a generic grid glyph for anything not mapped here.
func entitySymbol(for key: EntityKey) -> String {
    switch key {
    case .product: "shippingbox"
    case .recipe: "fork.knife"
    case .ingredient: "leaf"
    case .cookbook: "book.closed"
    case .location: "mappin.and.ellipse"
    case .inventory: "cube.box"
    case .meal: "fork.knife.circle"
    case .project: "hammer"
    case .task: "checklist"
    case .vendor: "storefront"
    case .purchase: "cart"
    case .usdaFood: "leaf.fill"
    case .image: "photo"
    default: "square.grid.2x2"
    }
}

#Preview {
    NavigationStack { BrowseRootView() }
}
