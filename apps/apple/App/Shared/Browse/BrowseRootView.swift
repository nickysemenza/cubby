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
            Section {
                NavigationLink {
                    GardenRootView()
                } label: {
                    HStack(spacing: PorcelainTokens.Space.md) {
                        Image(systemName: "leaf")
                            .foregroundStyle(PorcelainTokens.cobalt)
                            .frame(width: 20)
                        Text("Garden")
                            .font(.porcelainBody)
                        Spacer()
                    }
                    .frame(minHeight: PorcelainTokens.touchTarget)
                }
                .listRowInsets(browseRowInsets)
                .porcelainListRow()
            } header: {
                headerTitle("Garden")
            }
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
        .refreshControl { await counts.load(client: model.client) }
    }

    @ViewBuilder
    private func header(for domain: AppDomain) -> some View {
        headerTitle(domain.title, domain: domain)
    }

    @ViewBuilder
    private func headerTitle(_ title: String, domain: AppDomain? = nil) -> some View {
        HStack(spacing: PorcelainTokens.Space.sm) {
            if let domain { DomainMark(domain) }
            Eyebrow(title)
            Spacer()
        }
        .padding(.top, PorcelainTokens.Space.lg)
        .padding(.bottom, PorcelainTokens.Space.sm)
        .listRowInsets(
            EdgeInsets(
                top: 0, leading: PorcelainTokens.Space.lg, bottom: 0, trailing: PorcelainTokens.Space.lg)
        )
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
    /// plural names of everything else in the domain, for the footnote line. `httpActions` is
    /// authoritative over the kernel roster's `descriptor.actions` here — it's the set the HTTP
    /// document actually routes (see `GenericEntityListModel.load`).
    private func descriptors(in domain: AppDomain) -> (rows: [EntityDescriptor], unlisted: [String]) {
        let matches = descriptorsMatchingQuery.filter { $0.key.domain == domain }
        let rows = matches.filter { $0.key.httpActions.contains(.list) }.sorted { $0.plural < $1.plural }
        let unlisted = matches.filter { !$0.key.httpActions.contains(.list) }.sorted { $0.plural < $1.plural }
            .map(\.plural)
        return (rows, unlisted)
    }
}

/// Row counts from `GET /api/v1/dashboard/counts`, loaded once per host. `nil` while loading or on
/// failure, so a Browse row shows nothing on the right rather than a stale or fabricated number.
@Observable
final class BrowseCountsModel {
    private(set) var counts: DashboardCounts?

    func load(client: CubbyClient) async {
        do {
            counts = try await client.dashboardCounts()
        } catch {
            counts = nil
            Diagnostics.report(error, context: "browse.counts")
        }
    }

    func count(for key: EntityKey) -> Int? {
        counts?.count(for: key)
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
/// Read off the generated catalog (`presentation.icons.sfSymbol` in the entity declarations).
func entitySymbol(for key: EntityKey) -> String {
    EntityCatalog[key].sfSymbol
}

#Preview {
    NavigationStack { BrowseRootView() }.environment(PreviewFixtures.signedInModel())
}
