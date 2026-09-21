import CubbyKit
import SwiftUI

/// The Search tab: search-as-you-type across every intent-exposed entity, scoped by kind, with a
/// scanner sheet for the barcode/ISBN/label path. Owns a `SearchModel` created per host, mirroring
/// `CaptureView`/`CaptureModel`.
struct SearchView: View {
    @Environment(AppModel.self) private var model
    @State private var search: SearchModel?

    init(search: SearchModel? = nil) {
        // `search` is a test/preview injection seam; every production call site is
        // `SearchView()` with no argument, and this is the persistent Search tab root — never
        // re-presented via an item-keyed sheet with a changing `search` value.
        _search = State(initialValue: search)  // state-init-ok
    }

    var body: some View {
        Group {
            if let search {
                SearchContent(search: search)
            } else {
                LoadingIndicator.screen(label: "Loading Search")
            }
        }
        .task(id: model.host) {
            if search == nil { search = SearchModel(client: model.client) }
            if let search {
                applyPendingQuery(to: search)
                await search.start()
            }
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

/// Plain-state search UI, split out so snapshot tests can render it directly (seeded via
/// `SearchModel`'s `#if DEBUG` preview initializer) without `SearchView`'s network-backed `.task`.
struct SearchContent: View {
    @Bindable var search: SearchModel
    @Environment(AppModel.self) private var model
    @Environment(\.dismissSearch) private var dismissSearch
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @State private var scanning = false
    @State private var creatingProduct = false
    @State private var presentation = ListPresentationChoice.list
    @FocusState private var searchFieldFocused: Bool
    /// The last `navigator.focusSearchRequest` this view already acted on, so a fresh mount (the
    /// common case: switching to the Search tab normally) doesn't steal focus, while a request
    /// from ⌘F (`CubbyCommands`) does — whether it lands before this view exists (`.task` below)
    /// or after (`.onChange` below).
    @State private var lastHandledFocusRequest = 0

    /// The search-role tab supplies the field on iOS; pinning it in the drawer keeps it visible
    /// while results scroll. macOS has no drawer, so the toolbar field is the only placement.
    private static var searchPlacement: SearchFieldPlacement {
        #if os(iOS)
            .navigationBarDrawer(displayMode: .always)
        #else
            .automatic
        #endif
    }

    /// "Search Cubby" unscoped; "Search Products" (etc.) once a kind is picked from the toolbar
    /// menu below — the segmented `.searchScopes` control this replaced can't fit 15 kinds on
    /// iPhone without collapsing to "…", so the scope now only shows up here and in the menu.
    private var searchPrompt: String {
        guard let scope = search.scope else { return "Search Cubby" }
        return "Search \(EntityCatalog[scope].plural)"
    }

    var body: some View {
        content
            .porcelainScreen()
            .navigationTitle("Search")
            .searchable(text: $search.query, placement: Self.searchPlacement, prompt: searchPrompt)
            #if os(iOS)
                .searchToolbarBehavior(.minimize)
            #endif
            .searchFocused($searchFieldFocused)
            .accessibilityIdentifier("search.content")
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
                // A segmented `.searchScopes` control can't fit 15 intent-exposed kinds on
                // iPhone without collapsing every label to "…", so the kind picker lives in this
                // menu instead — filled when a kind is chosen, so the scope reads at a glance.
                ToolbarItem(placement: .navigation) {
                    Menu {
                        Picker("Kind", selection: $search.scope) {
                            Text("All").tag(EntityKey?.none)
                            ForEach(EntityCatalog.intentExposed, id: \.key) { descriptor in
                                Label(descriptor.plural, systemImage: entitySymbol(for: descriptor.key))
                                    .tag(EntityKey?.some(descriptor.key))
                            }
                        }
                        .pickerStyle(.inline)
                    } label: {
                        Label(
                            "Filter by kind",
                            systemImage: search.scope == nil
                                ? "line.3.horizontal.decrease.circle"
                                : "line.3.horizontal.decrease.circle.fill"
                        )
                    }
                }
                ToolbarItem {
                    Button {
                        scanning = true
                    } label: {
                        Label("Scan a code", systemImage: "barcode.viewfinder")
                    }
                }
                ToolbarItem(placement: .primaryAction) {
                    presentationPicker
                }
            }
            .sheet(isPresented: $scanning) {
                ScanLookupSheet(onTextResolved: { search.query = $0 }).nativeSheet(.picker)
            }
            .task { applyPendingFocusRequest() }
            .onChange(of: model.navigator.focusSearchRequest) { applyPendingFocusRequest() }
    }

    /// Handles ⌘F landing either before this view exists (the `.task` above, on first appearance)
    /// or after (the `.onChange` above, while it's already on screen) — see
    /// `lastHandledFocusRequest`'s doc comment for why both are needed.
    private func applyPendingFocusRequest() {
        let request = model.navigator.focusSearchRequest
        guard request != lastHandledFocusRequest else { return }
        lastHandledFocusRequest = request
        searchFieldFocused = true
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
                List { LoadingIndicator(label: "Searching") }.listStyle(.plain)
            case .results(let groups):
                if presentation == .list {
                    resultsList(groups)
                } else {
                    resultsGrid(groups, density: presentation)
                }
            case .empty:
                ContentUnavailableView.search(text: search.query)
            case .failed(let message):
                ContentUnavailableView {
                    Label("Couldn't search Cubby", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(message)
                } actions: {
                    Button("Retry") { search.retry() }
                }
            }
        }
    }

    @ViewBuilder
    private var presentationPicker: some View {
        if prefersSegmentedPresentationPicker {
            Picker("View", selection: $presentation) {
                ForEach(ListPresentationChoice.allCases, id: \.self) { choice in
                    Text(choice.label).tag(choice)
                }
            }
            .pickerStyle(.segmented)
            .accessibilityLabel("View")
        } else {
            Picker("View", selection: $presentation) {
                ForEach(ListPresentationChoice.allCases, id: \.self) { choice in
                    Label(choice.label, systemImage: choice.symbol).tag(choice)
                }
            }
            .pickerStyle(.menu)
            .accessibilityLabel("View")
        }
    }

    private var prefersSegmentedPresentationPicker: Bool {
        guard !dynamicTypeSize.isAccessibilitySize else { return false }
        #if os(macOS)
            return true
        #else
            return horizontalSizeClass == .regular
        #endif
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
        List(
            selection: Binding<RecordSelection?>(
                get: { model.navigator.selectedRecords[.search] },
                set: { model.navigator.selectRecord($0, in: .search) }
            )
        ) {
            ForEach(groups) { group in
                Section(EntityCatalog[group.key].plural) {
                    ForEach(group.hits) { hit in
                        #if os(macOS)
                            SearchHitRow(hit: hit)
                                .tag(RecordSelection(key: group.key, id: hit.id))
                                .accessibilityIdentifier("search.result.\(hit.id)")
                        #else
                            NavigationLink(value: Route.entityDetail(group.key, id: hit.id)) {
                                SearchHitRow(hit: hit)
                            }
                            .simultaneousGesture(TapGesture().onEnded { RecentEntities.record(hit.id) })
                            .accessibilityIdentifier("search.result.\(hit.id)")
                        #endif
                    }
                }
            }
        }
        .listStyle(.plain)
    }

    private func resultsGrid(
        _ groups: [SearchModel.ResultGroup], density: ListPresentationChoice
    ) -> some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: PorcelainTokens.Space.md) {
                ForEach(groups) { group in
                    let descriptor = EntityCatalog[group.key]
                    Text(descriptor.plural)
                        .font(.headline)
                        .padding(.horizontal, PorcelainTokens.Space.md)
                        .accessibilityAddTraits(.isHeader)
                    EntityShelfView(
                        descriptor: descriptor,
                        rows: group.hits.map(Self.row),
                        density: density,
                        section: .search)
                }
            }
            .padding(.vertical, PorcelainTokens.Space.sm)
        }
    }

    private static func row(_ hit: SearchHit) -> EntityRow {
        EntityRow(
            id: hit.id, title: hit.title, subtitle: hit.subtitle, imageURL: hit.imageURL,
            raw: .object([:]))
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
                model.navigator.pendingCaptureCode = code
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
        model.navigator.openInPlace(.entity(key, id: id))
    }

    private func handleSubmit() async {
        let outcome = await search.submit()
        switch outcome {
        case .link(let link):
            dismissSearch()
            model.navigator.openInPlace(link)
        case .products(let rows, _) where rows.count == 1:
            if let row = rows.first { openEntity(.product, id: row.id) }
        case .products, .unknownCode, .text:
            // A multi-product match or an unknown code renders inline via `lookupOutcome`;
            // plain text is already what `query` is driving the ordinary search with.
            break
        }
    }

    private func createProduct(code: String) async {
        creatingProduct = true
        defer { creatingProduct = false }
        do {
            let found = try await model.client.findOrCreateProduct(raw: code)
            RecentEntities.record(found.product.id.rawValue)
            dismissSearch()
            model.navigator.openInPlace(.entity(.product, id: found.product.id.rawValue))
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
                url: hit.imageURL, size: 48, symbol: hit.key.map(entitySymbol(for:)) ?? "questionmark.square"
            )
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

#Preview("Empty", traits: .modifier(SignedInPreview())) {
    NavigationStack {
        SearchView()
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
                            typeHint: nil, imageUrl: row.imageURL?.absoluteString, matchKind: .prefix,
                            matchField: .title, matchReason: "name", matchTerms: []))
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
