import CubbyKit
import SwiftUI

struct PhotoEntityChooser: View {
    @Environment(AppModel.self) private var appModel
    @Environment(\.developerOverlays) private var developerOverlays
    let key: EntityKey
    let captureDates: [Date?]
    let heroItems: [PhotoSelectionItem]
    let importManifest: PhotoImportManifest?
    let onCreateNew: (PhotoNewRecordAffordance) -> Void
    let onSelect: (EntityRow) -> Void
    @State private var model: PhotoEntityChooserModel?
    @State private var searchText = ""
    @State private var rankOrder: [String: Int] = [:]
    @State private var rankScores: [String: PhotoEvidenceScorer.Score] = [:]
    @State private var rankingGeneration = UUID()
    @State private var isRanking = false

    private var descriptor: EntityDescriptor { EntityCatalog[key] }

    /// The leading "New <entity>" row's affordance: every entity declares a `createSelf` route
    /// (8b), so this is `nil` only if the catalog itself is missing that entity's coverage.
    private var newRecordAffordance: PhotoNewRecordAffordance? {
        let targets = PhotoImportManifest.createTargetOptions(for: key)
        if !targets.isEmpty {
            let selfOption = PhotoImportManifest.createSelfOption(for: key)
            return .createTarget(
                candidates: targets, fallback: selfOption?.route.enabled == true ? selfOption : nil)
        }
        guard let selfOption = PhotoImportManifest.createSelfOption(for: key) else { return nil }
        return .createSelf(selfOption)
    }

    @ViewBuilder
    var body: some View {
        if let search = descriptor.primarySearch {
            content.searchable(
                text: $searchText,
                prompt: search.placeholder)
        } else {
            content
        }
    }

    private var content: some View {
        VStack(spacing: 0) {
            if !heroItems.isEmpty {
                PhotoImportHero(items: heroItems)
            }
            if let importManifest {
                PhotoAnalysisDisclosure(manifest: importManifest)
                if importManifest.isResolvingSourceRecord {
                    HStack(spacing: 8) {
                        ProgressView().controlSize(.small)
                        Text("Finding existing…")
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal)
                    .padding(.top, 4)
                    .accessibilityIdentifier("photos.manifest.resolvingSource")
                }
            }
            newRecordRow
            Group {
                if let model {
                    if model.isSearching {
                        searchContent(model)
                    } else if !model.dateMatches.isEmpty || !model.recentRows.isEmpty {
                        destinationList(model)
                    } else {
                        emptyState(model)
                    }
                } else {
                    LoadingIndicator.screen(label: "Loading \(descriptor.plural)")
                }
            }
            .frame(maxHeight: .infinity)
        }
        .navigationTitle(descriptor.plural)
        #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
        #endif
        // Same shape as `EntityListView`: `.searchable` owns a plain `@State` string and the
        // model is told about changes. Binding the field straight to the observable model's
        // normalized `query` left the chooser showing unfiltered rows on macOS.
        .onChange(of: searchText) { _, value in model?.setSearchQuery(value) }
        .task(id: key) {
            searchText = ""
            if model == nil {
                model = PhotoEntityChooserModel(
                    descriptor: descriptor, captureDates: captureDates,
                    loader: { filters, query, page, sort in
                        if let query, !query.isEmpty {
                            return try await PhotoRecordSearch.page(
                                query: query, descriptor: descriptor, client: appModel.client,
                                page: page, pageSize: 25)
                        }
                        return try await appModel.client.list(
                            descriptor, page: page, pageSize: 25, sort: sort, filters: filters)
                    })
            }
            await model?.loadInitial()
        }
        .task(id: rankingInputID) {
            await rankLoadedRows()
        }
        .refreshControl { await model?.refresh() }
        .toolbar {
            if developerOverlays {
                ToolbarItem { CopyDiagnosticsButton { rankingDiagnostics } }
            }
        }
    }

    /// Developer overlays layer 7: rank/score/lane for every currently loaded row.
    private var rankingDiagnostics: [PhotoChooserRowDiagnostic] {
        loadedRows.enumerated().map { index, row in
            PhotoChooserRowDiagnostic(
                id: row.id, rank: rankOrder[row.id] ?? index,
                combined: rankScores[row.id]?.combined, lane: lane(for: row))
        }
    }

    private var rankingInputID: String {
        let dateIDs = model?.dateMatches.map(\.id).joined(separator: ",") ?? ""
        let recentIDs = model?.recentRows.map(\.id).joined(separator: ",") ?? ""
        let searchQuery = model?.search?.query ?? ""
        let searchIDs = model?.searchRows.map(\.id).joined(separator: ",") ?? ""
        return "\(key.rawValue)|\(searchQuery)|\(dateIDs)|\(recentIDs)|\(searchIDs)"
    }

    private var loadedRows: [EntityRow] {
        guard let model else { return [] }
        // A query replaces the date/recent lanes rather than adding to them; merging all three
        // made a search look unfiltered (typing "plum" still listed every recent planting).
        if model.isSearching { return model.searchRows }
        var seen = Set<String>()
        return (model.dateMatches + model.recentRows).filter { seen.insert($0.id).inserted }
    }

    /// Manual type selection still benefits from the prepared import evidence. The task is
    /// view-owned so a new search/type selection cancels stale work without coupling the list
    /// model to Vision or catalog services.
    private func rankLoadedRows() async {
        guard let importManifest else {
            rankOrder = [:]
            rankScores = [:]
            isRanking = false
            return
        }
        let rows = loadedRows
        guard !rows.isEmpty else {
            rankOrder = [:]
            rankScores = [:]
            isRanking = false
            return
        }
        let generation = UUID()
        rankingGeneration = generation
        isRanking = true
        do {
            let ranked = try await importManifest.rankRows(
                for: key, rows: rows, client: appModel.client)
            try Task.checkCancellation()
            guard rankingGeneration == generation else { return }
            rankOrder = Dictionary(
                uniqueKeysWithValues: ranked.enumerated().map { ($0.element.row.id, $0.offset) })
            rankScores = Dictionary(uniqueKeysWithValues: ranked.map { ($0.row.id, $0.score) })
        } catch is CancellationError {
            return
        } catch {
            guard rankingGeneration == generation else { return }
            rankOrder = [:]
            rankScores = [:]
            Diagnostics.report(error, context: "photos.destination.ranking.\(key.rawValue)")
        }
        if rankingGeneration == generation {
            isRanking = false
        }
    }

    /// Developer overlays layer 3: which evidence lane most likely placed `row` — the row's own
    /// list membership when it's unambiguous, else whether its score carries a visual identity hit.
    private func lane(for row: EntityRow) -> String {
        guard let model else { return "recent" }
        if model.isSearching { return "search" }
        if rankScores[row.id]?.identity == 1 { return "visual" }
        if model.dateMatches.contains(where: { $0.id == row.id }) { return "date" }
        return "recent"
    }

    private func ordered(_ rows: [EntityRow]) -> [EntityRow] {
        guard !rankOrder.isEmpty else { return rows }
        return rows.enumerated().sorted { lhs, rhs in
            let left = rankOrder[lhs.element.id] ?? Int.max
            let right = rankOrder[rhs.element.id] ?? Int.max
            return left == right ? lhs.offset < rhs.offset : left < right
        }.map(\.element)
    }

    @ViewBuilder
    private func emptyState(_ model: PhotoEntityChooserModel) -> some View {
        if model.isLoading {
            LoadingIndicator.screen(label: "Loading \(descriptor.plural)")
        } else if let message = model.dateError ?? model.recentError {
            ContentUnavailableView {
                Label("Couldn't load \(descriptor.plural)", systemImage: "exclamationmark.triangle")
            } description: {
                Text(message)
            } actions: {
                Button("Retry") { Task { await model.refresh() } }
                    .accessibilityIdentifier("photos.destination.retry")
            }
        } else {
            ContentUnavailableView("No \(descriptor.plural) yet", systemImage: entitySymbol(for: key))
        }
    }

    private func destinationList(_ model: PhotoEntityChooserModel) -> some View {
        List {
            if isRanking {
                Section {
                    ProgressView("Ranking likely matches…")
                        .font(.caption)
                }
            }
            if model.hasDateMatches {
                Section {
                    if let error = model.dateError {
                        Text(error).foregroundStyle(.secondary)
                        Button("Retry date matches") { Task { await model.refresh() } }
                    }
                    ForEach(ordered(model.dateMatches)) { row in destinationRow(row, model: model) }
                    if model.hasMoreDateMatches {
                        Button {
                            Task { await model.loadMoreDateMatches() }
                        } label: {
                            if model.isLoadingDateNextPage {
                                LoadingIndicator(label: "Loading more matches")
                            } else {
                                Text("Load more matches")
                            }
                        }
                        .disabled(model.isLoadingDateNextPage)
                    }
                } header: {
                    Text(
                        "Matches \(model.captureDate?.formatted(date: .abbreviated, time: .omitted) ?? "photo date")"
                    )
                }
            }
            Section {
                if let error = model.recentError {
                    Text(error).foregroundStyle(.secondary)
                    Button("Retry recent records") { Task { await model.refresh() } }
                }
                ForEach(ordered(model.recentRows)) { row in destinationRow(row, model: model) }
                if model.hasMoreRecents {
                    Button {
                        Task { await model.loadMoreRecents() }
                    } label: {
                        if model.isLoadingRecentNextPage {
                            LoadingIndicator(label: "Loading more recent records")
                        } else {
                            Text("Load more recent records")
                        }
                    }
                    .disabled(model.isLoadingRecentNextPage)
                }
            } header: {
                Text("Recently edited")
            }
        }
    }

    @ViewBuilder
    private func searchContent(_ model: PhotoEntityChooserModel) -> some View {
        if let search = model.search {
            if search.rows.isEmpty {
                switch search.phase {
                case .idle, .debouncing, .loading:
                    LoadingIndicator.screen(label: "Searching \(descriptor.plural)")
                case .failed(let message):
                    ContentUnavailableView {
                        Label("Couldn't search \(descriptor.plural)", systemImage: "exclamationmark.triangle")
                    } description: {
                        Text(message)
                    } actions: {
                        Button("Retry") { search.retry() }
                    }
                case .loaded:
                    ContentUnavailableView("No matching \(descriptor.plural)", systemImage: "magnifyingglass")
                }
            } else {
                List {
                    ForEach(ordered(search.rows)) { row in destinationRow(row, model: model) }
                    if search.hasMore {
                        Button {
                            Task { await search.loadNextPage() }
                        } label: {
                            if search.phase == .loading {
                                LoadingIndicator(label: "Loading more \(descriptor.plural)")
                            } else {
                                Text("Load more")
                            }
                        }
                        .disabled(search.phase != .loaded)
                    }
                }
            }
        } else {
            ContentUnavailableView("Search unavailable", systemImage: "magnifyingglass")
        }
    }

    @ViewBuilder
    private func destinationRow(_ row: EntityRow, model: PhotoEntityChooserModel) -> some View {
        Button {
            onSelect(row)
        } label: {
            VStack(alignment: .leading, spacing: 2) {
                EntityRowView(key: key, row: row, photoMode: true)
                if developerOverlays {
                    DevOverlayText(rankDiagnosticCaption(for: row))
                }
            }
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("photos.destination.row.\(row.id)")
    }

    /// "#2 · 0.74 · date" — rank position, combined score, and lane (developer overlays layer 3).
    private func rankDiagnosticCaption(for row: EntityRow) -> String {
        let rank = rankOrder[row.id].map { "#\($0 + 1)" } ?? "—"
        let combined = rankScores[row.id].map { String(format: "%.2f", $0.combined) } ?? "—"
        return "\(rank) · \(combined) · \(lane(for: row))"
    }

    /// A leading, always-visible (never hidden, regardless of loading/search/empty state) "New
    /// <entity>" row — enabled, or disabled with its `disabledReason` as a caption.
    @ViewBuilder
    private var newRecordRow: some View {
        if let affordance = newRecordAffordance {
            let (title, enabled, disabledReason): (String, Bool, String?) =
                switch affordance {
                case .createSelf(let option):
                    (option.menuTitle, option.route.enabled, option.route.disabledReason)
                case .createTarget:
                    ("New \(descriptor.singular)", true, nil)
                }
            Divider()
            Button {
                onCreateNew(affordance)
            } label: {
                HStack(spacing: 12) {
                    Image(systemName: "plus.circle").frame(width: 24)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(title)
                        if let disabledReason {
                            Text(disabledReason).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
            }
            .disabled(!enabled)
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .accessibilityIdentifier("photos.destination.new.\(key.rawValue)")
            Divider()
        }
    }
}
