import CubbyKit
import SwiftUI

/// The Search tab: search-as-you-type across every intent-exposed entity, scoped by kind, with a
/// scanner sheet for the barcode/ISBN/label path. Owns a `SearchModel` created per host, mirroring
/// `CaptureView`/`CaptureModel`.
struct SearchView: View {
    @Environment(AppModel.self) private var model
    @State private var search: SearchModel?

    var body: some View {
        Group {
            if let search {
                SearchContent(search: search)
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .task(id: model.host) {
            let search = SearchModel(client: model.client)
            self.search = search
            await search.start()
            applyPendingQuery(to: search)
        }
        .onChange(of: model.navigator.pendingSearchQuery) {
            if let search { applyPendingQuery(to: search) }
        }
    }

    /// An intent's fallback ("Find eggs" with no single match) lands here as prefilled text, not
    /// as an immediate server round trip — the same debounced watch a typed query goes through.
    private func applyPendingQuery(to search: SearchModel) {
        if let query = model.navigator.takeSearchQuery() { search.query = query }
    }
}

private struct SearchContent: View {
    @Bindable var search: SearchModel
    @Environment(AppModel.self) private var model
    @Environment(\.dismissSearch) private var dismissSearch
    @State private var scanning = false
    @State private var creatingProduct = false

    /// The search-role tab supplies the field on iOS; pinning it in the drawer keeps it visible
    /// while results scroll. macOS has no drawer, so the toolbar field is the only placement.
    private static var searchPlacement: SearchFieldPlacement {
        #if os(iOS)
            .navigationBarDrawer(displayMode: .always)
        #else
            .automatic
        #endif
    }

    var body: some View {
        content
            .porcelainScreen()
            .navigationTitle("Search")
            .searchable(text: $search.query, placement: Self.searchPlacement, prompt: "Search Cubby")
            .searchScopes($search.scope) {
                Text("All").tag(EntityKey?.none)
                ForEach(EntityCatalog.intentExposed, id: \.key) { descriptor in
                    Text(descriptor.plural).tag(EntityKey?.some(descriptor.key))
                }
            }
            .searchSuggestions {
                if search.query.isEmpty {
                    ForEach(search.recents) { recent in
                        Button {
                            openEntity(recent.key, id: recent.row.id)
                        } label: {
                            Label(recent.row.title, systemImage: entitySymbol(for: recent.key))
                        }
                    }
                }
            }
            .onSubmit(of: .search) {
                Task { await handleSubmit() }
            }
            .scrollDismissesKeyboard(.immediately)
            .refreshControl { await search.refreshRecents() }
            .toolbar {
                ToolbarItem {
                    Button {
                        scanning = true
                    } label: {
                        Label("Scan a code", systemImage: "barcode.viewfinder")
                    }
                }
            }
            .sheet(isPresented: $scanning) {
                ScanLookupSheet(onTextResolved: { search.query = $0 })
            }
    }

    @ViewBuilder
    private var content: some View {
        if let outcome = search.lookupOutcome {
            ScrollView {
                codePanel(for: outcome)
                    .padding(PorcelainTokens.Space.lg)
            }
            .porcelainScreen()
        } else {
            switch search.phase {
            case .idle:
                emptyState
            case .searching:
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            case .results(let groups):
                resultsList(groups)
            case .empty:
                ContentUnavailableView.search(text: search.query)
            case .failed(let message):
                ContentUnavailableView(
                    "Couldn't search Cubby", systemImage: "exclamationmark.triangle",
                    description: Text(message))
            }
        }
    }

    /// The un-searched state: recents alone don't need a big empty view (they show as
    /// suggestions), so this is mostly an invitation to scan instead of type.
    private var emptyState: some View {
        ContentUnavailableView {
            Label("Search Cubby", systemImage: "magnifyingglass")
        } description: {
            Text("Find a product, location, recipe, or anything else.")
        } actions: {
            Button("Scan a code") { scanning = true }
        }
    }

    private func resultsList(_ groups: [SearchModel.ResultGroup]) -> some View {
        List {
            ForEach(groups) { group in
                Section(EntityCatalog[group.key].plural) {
                    ForEach(group.hits) { hit in
                        NavigationLink(value: Route.entityDetail(group.key, id: hit.id)) {
                            SearchHitRow(hit: hit)
                        }
                        .simultaneousGesture(
                            TapGesture().onEnded { RecentEntities.record(hit.id) }
                        )
                    }
                }
            }
        }
        .listStyle(.plain)
    }

    @ViewBuilder
    private func codePanel(for outcome: LookupOutcome) -> some View {
        switch outcome {
        case .products(let rows, let code):
            ProductMatchesPanel(rows: rows, code: code) { row in openEntity(.product, id: row.id) }
        case .unknownCode(let code, let catalog):
            UnknownCodePanel(code: code, catalog: catalog, creating: creatingProduct) {
                Task { await createProduct(code: code) }
            } onStock: {
                model.navigator.pendingCaptureCode = code.value
                dismissSearch()
                model.navigator.open(.capture(location: nil))
            }
        case .link, .text:
            EmptyView()
        }
    }

    private func openEntity(_ key: EntityKey, id: String) {
        RecentEntities.record(id)
        dismissSearch()
        model.navigator.open(.entity(key, id: id))
    }

    private func handleSubmit() async {
        let outcome = await search.submit()
        switch outcome {
        case .link(let link):
            dismissSearch()
            model.navigator.open(link)
        case .products(let rows, _) where rows.count == 1:
            if let row = rows.first { openEntity(.product, id: row.id) }
        case .products, .unknownCode, .text:
            // A multi-product match or an unknown code renders inline via `lookupOutcome`;
            // plain text is already what `query` is driving the ordinary search with.
            break
        }
    }

    private func createProduct(code: ScanCode) async {
        creatingProduct = true
        defer { creatingProduct = false }
        do {
            guard let found = try await model.client.findOrCreateProduct(code: code) else { return }
            RecentEntities.record(found.product.id.rawValue)
            dismissSearch()
            model.navigator.open(.entity(.product, id: found.product.id.rawValue))
        } catch {
            model.handle(error)
        }
    }
}

/// A `search.find` hit rendered like a Browse row: same thumb, same two-line title/subtitle.
private struct SearchHitRow: View {
    let hit: SearchHit

    var body: some View {
        HStack(spacing: PorcelainTokens.Space.md) {
            Thumb(
                url: hit.imageURL, size: 48, symbol: hit.key.map(entitySymbol(for:)) ?? "questionmark.square")
            VStack(alignment: .leading, spacing: 2) {
                Text(hit.title)
                    .font(.body.weight(.semibold))
                    .foregroundStyle(PorcelainTokens.graphite)
                    .lineLimit(2)
                if let subtitle = hit.subtitle, !subtitle.isEmpty {
                    Text(subtitle)
                        .font(.porcelainBody)
                        .foregroundStyle(PorcelainTokens.graphiteSecondary)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: PorcelainTokens.Space.sm)
        }
        .padding(.vertical, PorcelainTokens.Space.xs)
    }
}

#Preview("Empty") {
    NavigationStack {
        SearchView().environment(PreviewFixtures.signedInModel())
    }
}

#Preview("Results") {
    NavigationStack {
        List {
            Section("Products") {
                ForEach(PreviewFixtures.sampleRows) { row in
                    SearchHitRow(
                        hit: SearchHit(
                            id: row.id, entityType: "product", title: row.title, subtitle: row.subtitle,
                            typeHint: nil, imageURL: row.imageURL, matchKind: "text", matchReason: "name"))
                }
            }
        }
        .listStyle(.plain)
        .porcelainScreen()
        .navigationTitle("Search")
    }
}

#Preview("Error") {
    NavigationStack {
        ContentUnavailableView(
            "Couldn't search Cubby", systemImage: "exclamationmark.triangle",
            description: Text("The server took too long to respond."))
    }
}
