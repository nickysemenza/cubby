import CubbyKit
import SwiftUI

/// Every entity in `EntityCatalog`, grouped by domain line in the order the web rail uses. The
/// catalog itself is static; the one thing this screen fetches is the per-entity row count, so
/// each domain reads as "how much is in here" rather than just a directory.
struct BrowseRootView: View {
    @Environment(AppModel.self) private var model
    @State private var query = ""
    @State private var counts = BrowseCountsModel()

    var body: some View {
        List {
            ForEach(AppDomain.allCases) { domain in
                let group = descriptors(in: domain)
                if !group.rows.isEmpty || !group.unlisted.isEmpty {
                    Section {
                        ForEach(group.rows, id: \.key) { descriptor in
                            row(for: descriptor)
                        }
                        if !group.unlisted.isEmpty {
                            unlistedFootnote(names: group.unlisted)
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
        .task(id: model.host) {
            await counts.load(client: model.client)
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

    private func row(for descriptor: EntityDescriptor) -> some View {
        NavigationLink(value: Route.entityList(descriptor.key)) {
            EntityBrowseRow(descriptor: descriptor, count: counts.count(for: descriptor.key))
        }
        .listRowInsets(browseRowInsets)
        .porcelainListRow()
    }

    /// A single quiet line for entities with no list route (cookbooks, USDA foods, images): naming
    /// them here means they still show up in search and in the domain they belong to, without
    /// pretending to be tappable rows.
    private func unlistedFootnote(names: [String]) -> some View {
        Text("Also: \(names.joined(separator: ", ")) — no list route yet")
            .font(.porcelainLabel)
            .foregroundStyle(PorcelainTokens.graphiteSecondary)
            .padding(.vertical, PorcelainTokens.Space.sm)
            .listRowInsets(browseRowInsets)
            .porcelainListRow()
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

    /// Split for one domain: `rows` are listable (real `NavigationLink`s), `unlisted` are the
    /// plural names of everything else in the domain, for the footnote line.
    private func descriptors(in domain: AppDomain) -> (rows: [EntityDescriptor], unlisted: [String]) {
        let matches = descriptorsMatchingQuery.filter { $0.key.domain == domain }
        let rows = matches.filter { $0.actions.contains(.list) }.sorted { $0.plural < $1.plural }
        let unlisted = matches.filter { !$0.actions.contains(.list) }.sorted { $0.plural < $1.plural }.map(\.plural)
        return (rows, unlisted)
    }
}

/// Row counts from `GET /api/v1/dashboard/counts`, loaded once per host. `nil` while loading or on
/// failure, so a Browse row shows nothing on the right rather than a stale or fabricated number.
@Observable
final class BrowseCountsModel {
    private(set) var counts: [String: Int]?

    func load(client: CubbyClient) async {
        do {
            let data = try await client.raw.call(
                OperationRoute(operationID: "dashboard.counts", method: .get, path: "/api/v1/dashboard/counts")
            )
            counts = data.objectValue?.compactMapValues { $0.doubleValue.map(Int.init) }
        } catch {
            counts = nil
        }
    }

    func count(for key: EntityKey) -> Int? {
        // The response spells the USDA food count `usdaFoods` (plural); every other key matches
        // `EntityKey.rawValue` directly.
        counts?[key == .usdaFood ? "usdaFoods" : key.rawValue]
    }
}

/// One catalog row: the entity's own glyph in its domain color, its plural name, and (once loaded)
/// how many records exist.
private struct EntityBrowseRow: View {
    let descriptor: EntityDescriptor
    let count: Int?

    var body: some View {
        HStack(spacing: PorcelainTokens.Space.md) {
            DomainMark(descriptor.key, style: .symbol, size: 15)
                .frame(width: 20)
            Text(descriptor.plural)
                .font(.porcelainBody)
            Spacer(minLength: PorcelainTokens.Space.sm)
            if let count {
                Text(count.formatted())
                    .font(.porcelainData)
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
    NavigationStack { BrowseRootView() }.environment(PreviewFixtures.signedInModel())
}
