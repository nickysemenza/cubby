import CubbyKit
import SwiftUI

/// A person-scoped smart collection. The server owns both eligibility rules: effective ownership
/// and the apparel category; native renders its product projection as the existing product shelf.
struct WardrobeView: View {
    let ownerID: String
    let ownerName: String

    @Environment(AppModel.self) private var appModel
    @State private var model: WardrobeModel?
    @State private var searchText = ""

    var body: some View {
        Group {
            if let model {
                content(model)
            } else {
                LoadingIndicator.screen(label: "Loading wardrobe")
            }
        }
        .porcelainScreen()
        .navigationTitle("\(ownerName)’s Wardrobe")
        .searchable(text: $searchText, prompt: "Search wardrobe")
        .task(id: ownerID) {
            if model == nil { model = WardrobeModel(client: appModel.client, ownerID: ownerID) }
            await model?.load(search: searchText)
        }
        .onSubmit(of: .search) { Task { await model?.load(search: searchText) } }
        .refreshControl { await model?.load(search: searchText) }
    }

    @ViewBuilder
    private func content(_ model: WardrobeModel) -> some View {
        switch model.phase {
        case .idle, .loading:
            LoadingIndicator.screen(label: "Loading wardrobe")
        case .failed(let message):
            ContentUnavailableView {
                Label("Couldn’t load wardrobe", systemImage: "tshirt")
            } description: {
                Text(message)
            } actions: {
                Button("Retry") { Task { await model.load(search: searchText) } }
            }
        case .loaded:
            if model.rows.isEmpty {
                ContentUnavailableView(
                    searchText.isEmpty ? "No apparel yet" : "No matching apparel",
                    systemImage: "tshirt")
            } else {
                ScrollView {
                    Text("\(model.totalCount.formatted()) items")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, PorcelainTokens.Space.md)
                    EntityShelfView(
                        descriptor: EntityCatalog[.product], rows: model.rows,
                        subtitleOverride: { $0.subtitle })
                    if model.hasMore {
                        Button("Load more") { Task { await model.loadNextPage() } }
                            .disabled(model.loadingNextPage)
                            .padding()
                    }
                }
            }
        }
    }
}

@MainActor @Observable
final class WardrobeModel {
    enum Phase: Equatable { case idle, loading, loaded, failed(String) }

    private let client: CubbyClient
    private let ownerID: String
    private let pageSize = 50
    private var pageIndex = 0
    private var generation = 0
    private var loadedSearch = ""
    private(set) var phase: Phase = .idle
    private(set) var rows: [EntityRow] = []
    private(set) var totalCount = 0
    private(set) var loadingNextPage = false

    var hasMore: Bool { rows.count < totalCount }

    init(client: CubbyClient, ownerID: String) {
        self.client = client
        self.ownerID = ownerID
    }

    func load(search: String) async {
        generation += 1
        let requestGeneration = generation
        loadedSearch = search
        loadingNextPage = false
        phase = .loading
        pageIndex = 0
        do {
            let page = try await client.wardrobe(
                ownerID: ownerID, search: search, pageIndex: 0, pageSize: pageSize)
            guard requestGeneration == generation else { return }
            rows = page.products.map(Self.row)
            totalCount = page.totalCount
            phase = .loaded
        } catch {
            guard requestGeneration == generation else { return }
            phase = .failed((error as? CubbyAPIError)?.detail?.message ?? String(describing: error))
            Diagnostics.report(error, context: "wardrobe.load")
        }
    }

    func loadNextPage() async {
        guard hasMore, !loadingNextPage else { return }
        loadingNextPage = true
        let requestGeneration = generation
        defer {
            if requestGeneration == generation { loadingNextPage = false }
        }
        do {
            let next = pageIndex + 1
            let page = try await client.wardrobe(
                ownerID: ownerID, search: loadedSearch, pageIndex: next, pageSize: pageSize)
            guard requestGeneration == generation else { return }
            let existingIDs = Set(rows.map(\.id))
            rows.append(contentsOf: page.products.map(Self.row).filter { !existingIDs.contains($0.id) })
            totalCount = page.totalCount
            pageIndex = next
        } catch {
            Diagnostics.report(error, context: "wardrobe.loadNextPage")
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
    /// owner. Summarizing that projection here avoids accidentally showing household-wide stock.
    private static func wardrobeSubtitle(_ product: CollectionProductOut) -> String? {
        var parts = [String]()
        if !product.manufacturer.isEmpty { parts.append(product.manufacturer) }

        let inventory = product.inventory ?? []
        let totals = Dictionary(grouping: inventory, by: { $0.amount.unit })
            .map { unit, rows in
                let value = rows.reduce(0) { $0 + $1.amount.value }
                return "\(value.formatted(.number.precision(.fractionLength(0...2)))) \(unit)"
            }
            .sorted()
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
