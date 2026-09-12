import CubbyKit
import SwiftUI

/// Every entity in `EntityCatalog`, grouped by domain line in the order the web rail uses.
/// Static — no network call, since the catalog already carries plural names, shortcode prefixes,
/// and which actions exist.
struct BrowseRootView: View {
    @State private var query = ""

    var body: some View {
        List {
            ForEach(AppDomain.allCases) { domain in
                let rows = descriptors(in: domain)
                if !rows.isEmpty {
                    Section {
                        ForEach(rows, id: \.key) { descriptor in
                            row(for: descriptor)
                        }
                    } header: {
                        header(for: domain)
                    }
                }
            }
        }
        .listStyle(.plain)
        .porcelainScreen()
        .navigationTitle("Browse")
        .searchable(text: $query)
        .overlay {
            if descriptorsMatchingQuery.isEmpty {
                ContentUnavailableView.search(text: query)
            }
        }
    }

    @ViewBuilder
    private func header(for domain: AppDomain) -> some View {
        HStack(spacing: PorcelainTokens.Space.sm) {
            DomainMark(domain)
            Eyebrow(domain.title)
            Spacer()
        }
        .padding(.top, PorcelainTokens.Space.lg)
        .padding(.bottom, PorcelainTokens.Space.sm)
        .listRowInsets(EdgeInsets(top: 0, leading: PorcelainTokens.Space.lg, bottom: 0, trailing: PorcelainTokens.Space.lg))
        .background(PorcelainTokens.canvas)
    }

    @ViewBuilder
    private func row(for descriptor: EntityDescriptor) -> some View {
        if descriptor.actions.contains(.list) {
            NavigationLink(value: Route.entityList(descriptor.key)) {
                EntityBrowseRow(descriptor: descriptor)
            }
            .listRowInsets(browseRowInsets)
            .porcelainListRow()
        } else {
            EntityBrowseRow(descriptor: descriptor, note: "No list route")
                .foregroundStyle(PorcelainTokens.graphiteSecondary)
                .listRowInsets(browseRowInsets)
                .porcelainListRow()
                .disabled(true)
        }
    }

    /// The row owns its own 44pt height, so the list must not add its default vertical padding
    /// on top of it.
    private var browseRowInsets: EdgeInsets {
        EdgeInsets(
            top: 0, leading: PorcelainTokens.Space.lg,
            bottom: 0, trailing: PorcelainTokens.Space.lg
        )
    }

    private var descriptorsMatchingQuery: [EntityDescriptor] {
        guard !query.isEmpty else { return EntityCatalog.all }
        return EntityCatalog.all.filter { $0.plural.localizedCaseInsensitiveContains(query) }
    }

    private func descriptors(in domain: AppDomain) -> [EntityDescriptor] {
        descriptorsMatchingQuery
            .filter { $0.key.domain == domain }
            .sorted { lhs, rhs in
                let lhsListable = lhs.actions.contains(.list)
                let rhsListable = rhs.actions.contains(.list)
                if lhsListable != rhsListable { return lhsListable }
                return lhs.plural < rhs.plural
            }
    }
}

/// One catalog row: the entity's own glyph in its domain color, its plural name, and the shortcode
/// prefix that identifies its records everywhere else in Cubby.
private struct EntityBrowseRow: View {
    let descriptor: EntityDescriptor
    var note: String?

    var body: some View {
        HStack(spacing: PorcelainTokens.Space.md) {
            DomainMark(descriptor.key, style: .symbol, size: 15)
                .frame(width: 20)
            VStack(alignment: .leading, spacing: 1) {
                Text(descriptor.plural)
                    .font(.porcelainBody)
                if let note {
                    Text(note)
                        .font(.porcelainLabel)
                        .foregroundStyle(PorcelainTokens.graphiteSecondary)
                }
            }
            Spacer(minLength: PorcelainTokens.Space.sm)
            if let prefix = descriptor.shortcodePrefix {
                Text(prefix)
                    .font(.porcelainCode)
                    .foregroundStyle(PorcelainTokens.graphiteSecondary)
            }
        }
        .frame(minHeight: PorcelainTokens.touchTarget)
    }
}

/// SF Symbol per entity key, used by Browse rows, `DomainMark`, and the list/detail empty states.
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
    case .expense: "dollarsign.circle"
    case .financialAccount: "building.columns"
    case .financialTransaction: "arrow.left.arrow.right"
    case .ledgerParty: "person.2"
    case .ledgerTransfer: "arrow.left.arrow.right.circle"
    case .wish: "star"
    case .usdaFood: "leaf.fill"
    case .image: "photo"
    }
}

#Preview {
    NavigationStack { BrowseRootView() }
}
