import CubbyKit
import SwiftUI

/// Resolves an existing destination through the route's manifest-owned relationship path.
/// The server revalidates this relationship inside the commit transaction; this view only
/// presents the bounded graph page so invalid arbitrary destinations are never offered.
struct PhotoRelatedDestinationChooser: View {
    @Environment(AppModel.self) private var appModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.developerOverlays) private var developerOverlays
    let context: PhotoRelatedContext
    let createOption: PhotoDestinationOption?
    let captureDate: Date?
    let heroItems: [PhotoSelectionItem]
    let importManifest: PhotoImportManifest
    let onSelect: (EntityRow) -> Void
    let onCreate: (PhotoDestinationOption, [String: JSONValue]) -> Void

    @State private var model: GenericEntityListModel?
    @State private var search = ""
    @State private var creation: PhotoDestinationOption?
    @State private var rankScores: [String: PhotoEvidenceScorer.Score] = [:]

    private nonisolated struct RelatedScope: Hashable, Sendable {
        let contextID: String
        let captureDate: Date?
    }

    private static let pageSize = 25
    private var descriptor: EntityDescriptor { context.option.descriptor }
    private var scope: RelatedScope { RelatedScope(contextID: context.id, captureDate: captureDate) }
    private var rows: [EntityRow] { (model?.rows ?? []).sorted { $0.title < $1.title } }

    private var filteredRows: [EntityRow] {
        guard !search.isEmpty else { return rows }
        return rows.filter {
            $0.title.localizedCaseInsensitiveContains(search)
                || $0.id.localizedCaseInsensitiveContains(search)
        }
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                if !heroItems.isEmpty {
                    PhotoImportHero(items: heroItems)
                }
                PhotoAnalysisDisclosure(manifest: importManifest)
                Group {
                    if let model, !rows.isEmpty {
                        destinationList(model)
                    } else if case .failed(let message)? = model?.phase {
                        LoadFailureView(title: "Couldn't load \(descriptor.plural)", message: message) {
                            await model?.refresh()
                        }
                    } else if model?.phase == .loaded {
                        ContentUnavailableView {
                            Label(
                                "No related \(descriptor.plural)",
                                systemImage: entitySymbol(for: context.option.route.target))
                        } description: {
                            Text("No existing destination matches this photo's capture time or day.")
                        } actions: {
                            if let createOption {
                                Button("Create \(createOption.descriptor.singular)") {
                                    creation = createOption
                                }
                                .buttonStyle(.borderedProminent)
                            }
                        }
                    } else {
                        LoadingIndicator.screen(label: "Loading related \(descriptor.plural)")
                    }
                }
                .frame(maxHeight: .infinity)
            }
            .navigationTitle("Related \(descriptor.plural)")
            #if os(iOS)
                .navigationBarTitleDisplayMode(.inline)
            #endif
            .searchable(text: $search, prompt: "Search name or shortcode")
            .toolbar {
                if developerOverlays {
                    ToolbarItem { CopyDiagnosticsButton { rankingDiagnostics } }
                }
            }
        }
        .nativeSheet(.editor)
        .task(id: scope) {
            let source = relatedSource()
            if let model {
                await model.setSource(source)
            } else {
                let model = GenericEntityListModel(
                    descriptor: descriptor, client: appModel.client, source: source)
                self.model = model
                await model.loadInitial()
            }
        }
        .task(id: rows.map(\.id)) { await rankRows() }
        .sheet(item: $creation) { option in
            PhotoRelatedCreateEditor(
                mode: .createRelated(option: option, source: context.source), captureDate: captureDate,
                heroItems: heroItems, importManifest: importManifest
            ) { option, _, body in
                onCreate(option, body)
                creation = nil
                dismiss()
            }
        }
    }

    private func destinationList(_ model: GenericEntityListModel) -> some View {
        List {
            if let createOption {
                Section {
                    Button("Create new \(createOption.descriptor.singular)") {
                        creation = createOption
                    }
                }
            }
            ForEach(Array(filteredRows.enumerated()), id: \.element.id) { index, row in
                Button {
                    onSelect(row)
                } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        EntityRowView(key: context.option.route.target, row: row, photoMode: true)
                        if developerOverlays {
                            DevOverlayText(rankDiagnosticCaption(for: row, rank: index))
                        }
                    }
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("photos.destination.related.\(row.id)")
            }
            if model.hasMore, search.isEmpty {
                if let error = model.nextPageError {
                    Text(error).foregroundStyle(.secondary)
                }
                Button {
                    Task { await model.loadNextPage() }
                } label: {
                    if model.activity == .loadingNextPage {
                        LoadingIndicator(label: "Loading more \(descriptor.plural)")
                    } else {
                        Text("Load more")
                    }
                }
                .disabled(model.activity != .idle)
            }
        }
    }

    /// Page 1 is the auto-resolve's preloaded page when there is one. A route with a declared
    /// relation filter pages the date-scoped list; otherwise the relationship cursor answers,
    /// with page N at offset `(N - 1) * pageSize` (the graph clamps `limit` to the same 25).
    private func relatedSource() -> EntityListPageSource {
        let context = context
        let captureDate = captureDate
        let client = appModel.client
        let pageSize = Self.pageSize
        return EntityListPageSource(id: scope) { @MainActor page in
            do {
                if page == 1, let preloaded = context.preloaded { return preloaded }
                if let listed = try await PhotoImportManifest.findRelated(
                    option: context.option, source: context.source, captureDate: captureDate,
                    client: client, page: page, pageSize: pageSize)
                {
                    return listed
                }
                return try await Self.relationshipPage(
                    context: context, client: client, page: page, pageSize: pageSize)
            } catch {
                if !(error is CancellationError) {
                    Diagnostics.report(error, context: "photos.destination.related.\(context.option.id)")
                }
                throw error
            }
        }
    }

    private static func relationshipPage(
        context: PhotoRelatedContext, client: CubbyClient, page: Int, pageSize: Int
    ) async throws -> ListPage<EntityRow> {
        guard let relationshipKey = context.option.route.relationPath.first,
            context.option.route.relationPath.count == 1
        else { throw UnsupportedRelationPath() }
        let root = EntityRef(entity: context.option.route.source, id: context.source.id)
        let offset = (page - 1) * pageSize
        let graph = try await client.relationshipPage(
            root: root, relationshipKey: relationshipKey, offset: offset, limit: pageSize)
        let branch = graph.branches.first {
            $0.root == root && $0.relationshipKey == relationshipKey
        }
        let nodes = Dictionary(
            graph.nodes.map { ($0.reference, $0) }, uniquingKeysWith: { _, newer in newer })
        let loaded = (branch?.items ?? []).compactMap { reference -> EntityRow? in
            guard reference.entity == context.option.route.target,
                let node = nodes[reference]
            else { return nil }
            return EntityRow(
                id: reference.id,
                title: node.label,
                subtitle: nil,
                imageURL: node.imageURL,
                raw: .object(["id": .string(reference.id), "name": .string(node.label)]))
        }
        // The cursor reports `nextOffset`, not a total: one past this page keeps `hasMore` true
        // until the cursor ends.
        let totalCount = branch?.nextOffset == nil ? offset + loaded.count : page * pageSize + 1
        return ListPage(
            items: loaded, meta: ListPageMeta(pageIndex: page, pageSize: pageSize, totalCount: totalCount))
    }

    private struct UnsupportedRelationPath: LocalizedError {
        var errorDescription: String? {
            "This relationship path is not supported by this version of Cubby."
        }
    }

    /// Developer overlays layer 3: this chooser has one flat list (no separate date/recent lanes),
    /// so ranking only adds the `combined` score; rank position is the list's own display order.
    private func rankRows() async {
        guard developerOverlays, !rows.isEmpty else { return }
        do {
            let ranked = try await importManifest.rankRows(
                for: context.option.route.target, rows: rows, client: appModel.client)
            rankScores = Dictionary(uniqueKeysWithValues: ranked.map { ($0.row.id, $0.score) })
        } catch is CancellationError {
        } catch {
            Diagnostics.report(error, context: "photos.destination.related.ranking.\(context.option.id)")
        }
    }

    /// "#2 · 0.74 · date" — every row here is already date/relation-scoped by `findRelated`, so the
    /// lane is "search" only while the local filter narrows it, else "date".
    private func rankDiagnosticCaption(for row: EntityRow, rank: Int) -> String {
        let combined = rankScores[row.id].map { String(format: "%.2f", $0.combined) } ?? "—"
        let lane = search.isEmpty ? "date" : "search"
        return "#\(rank + 1) · \(combined) · \(lane)"
    }

    private var rankingDiagnostics: [PhotoChooserRowDiagnostic] {
        filteredRows.enumerated().map { index, row in
            PhotoChooserRowDiagnostic(
                id: row.id, rank: index, combined: rankScores[row.id]?.combined,
                lane: search.isEmpty ? "date" : "search")
        }
    }
}
