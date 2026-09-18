import CubbyKit
import SwiftUI

/// Resolves an existing destination through the route's manifest-owned relationship path.
/// The server revalidates this relationship inside the commit transaction; this view only
/// presents the bounded graph page so invalid arbitrary destinations are never offered.
struct PhotoRelatedDestinationChooser: View {
    @Environment(AppModel.self) private var appModel
    @Environment(\.dismiss) private var dismiss
    let context: PhotoRelatedContext
    let createOption: PhotoDestinationOption?
    let captureDate: Date?
    let heroItems: [PhotoSelectionItem]
    let importManifest: PhotoImportManifest
    let onSelect: (EntityRow) -> Void
    let onCreate: (PhotoDestinationOption, [String: JSONValue]) -> Void

    @State private var rows: [EntityRow] = []
    @State private var nextOffset: Int?
    @State private var isLoading = true
    @State private var errorMessage: String?
    @State private var search = ""
    @State private var creation: PhotoDestinationOption?
    @State private var listPage = 1

    private var descriptor: EntityDescriptor { context.option.descriptor }

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
                    if isLoading, rows.isEmpty {
                        LoadingIndicator.screen(label: "Loading related \(descriptor.plural)")
                    } else if let errorMessage, rows.isEmpty {
                        ContentUnavailableView {
                            Label(
                                "Couldn't load \(descriptor.plural)", systemImage: "exclamationmark.triangle")
                        } description: {
                            Text(errorMessage)
                        } actions: {
                            Button("Retry") { Task { await load(reset: true) } }
                        }
                    } else if rows.isEmpty {
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
                        List {
                            if let createOption {
                                Section {
                                    Button("Create new \(createOption.descriptor.singular)") {
                                        creation = createOption
                                    }
                                }
                            }
                            ForEach(filteredRows) { row in
                                Button {
                                    onSelect(row)
                                } label: {
                                    EntityRowView(
                                        key: context.option.route.target, row: row, photoMode: true)
                                }
                                .buttonStyle(.plain)
                                .accessibilityIdentifier("photos.destination.related.\(row.id)")
                            }
                            if nextOffset != nil, search.isEmpty {
                                Button {
                                    Task { await load(reset: false) }
                                } label: {
                                    if isLoading {
                                        LoadingIndicator(label: "Loading more \(descriptor.plural)")
                                    } else {
                                        Text("Load more")
                                    }
                                }
                                .disabled(isLoading)
                            }
                        }
                    }
                }
                .frame(maxHeight: .infinity)
            }
            .navigationTitle("Related \(descriptor.plural)")
            #if os(iOS)
                .navigationBarTitleDisplayMode(.inline)
            #endif
            .searchable(text: $search, prompt: "Search name or shortcode")
        }
        .nativeSheet(.editor)
        .task {
            if let preloaded = context.preloaded {
                rows = preloaded.items.sorted { $0.title < $1.title }
                let hasMore = preloaded.meta.pageSize < preloaded.meta.totalCount
                nextOffset = hasMore ? preloaded.meta.pageSize : nil
                listPage = 2
                isLoading = false
            } else {
                await load(reset: true)
            }
        }
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

    private func load(reset: Bool) async {
        guard let relationshipKey = context.option.route.relationPath.first,
            context.option.route.relationPath.count == 1
        else {
            errorMessage = "This relationship path is not supported by this version of Cubby."
            isLoading = false
            return
        }
        if reset {
            rows = []
            nextOffset = nil
            listPage = 1
        }
        guard !isLoading || reset else { return }
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        do {
            if let page = try await PhotoImportManifest.findRelated(
                option: context.option, source: context.source, captureDate: captureDate,
                client: appModel.client, page: listPage, pageSize: 25)
            {
                rows = Dictionary(
                    grouping: rows + page.items, by: \.id
                ).values.compactMap(\.last).sorted { $0.title < $1.title }
                let hasMore = listPage * page.meta.pageSize < page.meta.totalCount
                nextOffset = hasMore ? listPage * page.meta.pageSize : nil
                listPage += 1
                return
            }
            let root = EntityRef(entity: context.option.route.source, id: context.source.id)
            let page = try await appModel.client.relationshipPage(
                root: root,
                relationshipKey: relationshipKey,
                offset: reset ? 0 : (nextOffset ?? 0),
                limit: 25)
            let branch = page.branches.first {
                $0.root == root && $0.relationshipKey == relationshipKey
            }
            let nodes = Dictionary(
                page.nodes.map { ($0.reference, $0) }, uniquingKeysWith: { _, newer in newer })
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
            rows = Dictionary(
                grouping: rows + loaded, by: \.id
            ).values.compactMap(\.last).sorted { $0.title < $1.title }
            nextOffset = branch?.nextOffset
        } catch is CancellationError {
            return
        } catch {
            errorMessage = error.localizedDescription
            Diagnostics.report(error, context: "photos.destination.related.\(context.option.id)")
        }
    }

}
