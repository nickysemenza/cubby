import CubbyKit
import SwiftUI

/// A person-scoped smart collection. The server owns both eligibility rules: effective ownership
/// and the apparel category; native renders its product projection as the existing product shelf.
/// Paging and search are the shared `GenericEntityListModel` over a collection page source.
struct WardrobeView: View {
    let ownerID: String
    let ownerName: String

    @Environment(AppModel.self) private var appModel
    @State private var model: GenericEntityListModel?
    @State private var searchText = ""

    var body: some View {
        Group {
            if let model {
                content(model)
            } else {
                LoadingIndicator.screen(label: "Loading wardrobe")
            }
        }
        .fieldGuideScreen()
        .navigationTitle("\(ownerName)’s Wardrobe")
        .searchable(text: $searchText, prompt: "Search wardrobe")
        .onChange(of: searchText) { _, value in model?.setSearchQuery(value) }
        .task(id: ownerID) {
            let source = Self.source(client: appModel.client, ownerID: ownerID)
            if let model {
                await model.setSource(source)
            } else {
                let model = GenericEntityListModel(
                    descriptor: EntityCatalog[.product], client: appModel.client, source: source)
                self.model = model
                await model.loadInitial()
            }
        }
        .refreshControl { await refresh() }
    }

    private func refresh() async {
        guard let model else { return }
        if let search = model.searchModel, model.isSearching {
            await search.refresh()
        } else {
            await model.refresh()
        }
    }

    @ViewBuilder
    private func content(_ model: GenericEntityListModel) -> some View {
        if let search = model.searchModel, model.isSearching {
            if !search.rows.isEmpty {
                shelf(
                    rows: search.rows, totalCount: search.meta?.totalCount, hasMore: search.hasMore,
                    isBusy: search.phase == .loading, refreshError: search.refreshError,
                    nextPageError: search.nextPageError, refresh: { await search.refresh() },
                    loadMore: { await search.loadNextPage() })
            } else if case .failed(let message) = search.phase {
                LoadFailureView(title: "Couldn’t load wardrobe", message: message) { search.retry() }
            } else if search.phase == .loaded {
                ContentUnavailableView("No matching apparel", systemImage: "tshirt")
            } else {
                LoadingIndicator.screen(label: "Loading wardrobe")
            }
        } else if !model.rows.isEmpty {
            shelf(
                rows: model.rows, totalCount: model.meta?.totalCount, hasMore: model.hasMore,
                isBusy: model.activity != .idle, refreshError: model.refreshError,
                nextPageError: model.nextPageError, refresh: { await model.refresh() },
                loadMore: { await model.loadNextPage() })
        } else if case .failed(let message) = model.phase {
            LoadFailureView(title: "Couldn’t load wardrobe", message: message) { await model.refresh() }
        } else if model.phase == .loaded {
            ContentUnavailableView("No apparel yet", systemImage: "tshirt")
        } else {
            LoadingIndicator.screen(label: "Loading wardrobe")
        }
    }

    /// Loaded rows stay on screen when a refresh or next page fails; the raw failure shows beside
    /// them with its own retry.
    private func shelf(
        rows: [EntityRow], totalCount: Int?, hasMore: Bool, isBusy: Bool, refreshError: String?,
        nextPageError: String?, refresh: @escaping @MainActor () async -> Void,
        loadMore: @escaping @MainActor () async -> Void
    ) -> some View {
        ScrollView {
            if let refreshError {
                InlineLoadFailure(message: refreshError, isRetrying: isBusy, retry: refresh)
                    .padding(.horizontal, FieldGuideTokens.Space.md)
            }
            if let totalCount {
                Text("\(totalCount.formatted()) items")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, FieldGuideTokens.Space.md)
            }
            EntityShelfView(
                descriptor: EntityCatalog[.product], rows: rows, subtitleOverride: { $0.subtitle })
            if let nextPageError {
                InlineLoadFailure(message: nextPageError, isRetrying: isBusy, retry: loadMore)
                    .padding(.horizontal, FieldGuideTokens.Space.md)
            } else if hasMore {
                Button("Load more") { Task { await loadMore() } }
                    .disabled(isBusy)
                    .padding()
            }
        }
    }

    /// The wardrobe collection query as a page source. Its rows are the collection's product
    /// projection, not the product list route, so declared enrichment stays off.
    private static func source(client: CubbyClient, ownerID: String) -> EntityListPageSource {
        EntityListPageSource(
            id: ownerID,
            loadPage: { @MainActor page in
                try await wardrobePage(client: client, ownerID: ownerID, search: nil, page: page)
            },
            searchPage: { @MainActor query, page in
                try await wardrobePage(client: client, ownerID: ownerID, search: query, page: page)
            })
    }

    /// `collection.referenceDetail` pages from 0; the shared paginator counts pages from 1.
    private static func wardrobePage(
        client: CubbyClient, ownerID: String, search: String?, page: Int
    ) async throws -> ListPage<EntityRow> {
        let pageSize = 50
        do {
            let out = try await client.wardrobe(
                ownerID: ownerID, search: search, pageIndex: page - 1, pageSize: pageSize)
            return ListPage(
                items: out.products.map(row),
                meta: ListPageMeta(pageIndex: page, pageSize: pageSize, totalCount: out.totalCount))
        } catch {
            if !(error is CancellationError) { Diagnostics.report(error, context: "wardrobe.load") }
            throw error
        }
    }

    private static func row(_ product: CollectionProductOut) -> EntityRow {
        let imageURL = product.imageUrl.flatMap(URL.init(string:))
        let subtitle = wardrobeSubtitle(product)
        let raw: JSONValue = [
            "id": .string(product.id.rawValue),
            "name": .string(product.name),
            "manufacturer": .string(product.manufacturer),
            "displayImages": .array(
                imageURL.map { [.object(["url": .string($0.absoluteString)])] } ?? []),
        ]
        return EntityRow(
            id: product.id.rawValue, title: product.name,
            subtitle: subtitle,
            imageURL: imageURL, raw: raw)
    }

    /// `collection.referenceDetail` has already filtered these inventory rows to the wardrobe's
    /// owner and summed them per unit (`inventoryTotals`); native only formats the result.
    private static func wardrobeSubtitle(_ product: CollectionProductOut) -> String? {
        var parts = [String]()
        if !product.manufacturer.isEmpty { parts.append(product.manufacturer) }

        let inventory = product.inventory ?? []
        let totals = (product.inventoryTotals ?? []).map {
            "\($0.value.formatted(.number.precision(.fractionLength(0...2)))) \($0.unit)"
        }
        if !totals.isEmpty { parts.append(totals.joined(separator: " + ")) }

        let ownerLocationIDs = Set(inventory.map(\.locationId))
        let locationNames = Set(
            product.placements.filter { ownerLocationIDs.contains($0.id) }.map(\.name)
        ).sorted()
        if !locationNames.isEmpty { parts.append(locationNames.joined(separator: ", ")) }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
}

#Preview("Wardrobe") {
    NavigationStack {
        WardrobeView(ownerID: "LPY-1234", ownerName: "Alex")
    }
    .environment(PreviewFixtures.signedInModel())
}
