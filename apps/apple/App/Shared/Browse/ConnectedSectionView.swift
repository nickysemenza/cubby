import CubbyKit
import SwiftUI

/// The records between a source and a target, as one compact line: intermediate records read by
/// entity kind (paths repeat names), each still opening its record, with the full name in the
/// accessibility label and help. Further paths disclose under "+N paths".
struct RecordPathView: View {
    let paths: [[ConnectedPathNode]]

    var body: some View {
        if let shortest = paths.first {
            VStack(alignment: .leading, spacing: 4) {
                trail(shortest)
                if paths.count > 1 {
                    DisclosureGroup("+\(paths.count - 1) \(paths.count == 2 ? "path" : "paths")") {
                        ForEach(Array(paths.dropFirst().enumerated()), id: \.offset) { indexed in
                            trail(indexed.element)
                        }
                    }
                }
            }
            .font(.caption)
        }
    }

    @ViewBuilder
    private func trail(_ path: [ConnectedPathNode]) -> some View {
        let middle = ConnectedPathPresentation.intermediates(path)
        if middle.isEmpty {
            Text("Direct").foregroundStyle(.secondary)
        } else {
            ScrollView(.horizontal) {
                HStack(spacing: 3) {
                    Text("via").foregroundStyle(.secondary)
                    ForEach(Array(middle.enumerated()), id: \.offset) { indexed in
                        let node = indexed.element
                        let kind = EntityCatalog[node.entityKind].singular
                        if indexed.offset > 0 {
                            Text("→").foregroundStyle(.secondary).accessibilityHidden(true)
                        }
                        NavigationLink(value: Route.entityDetail(node.entityKind, id: node.entityId)) {
                            Text(kind).lineLimit(1)
                        }
                        .buttonStyle(.borderless)
                        .accessibilityLabel("\(kind): \(node.label)")
                        .help("\(kind): \(node.label)")
                    }
                }
            }
            .scrollIndicators(.hidden)
        }
    }
}

/// One connected record: identity link, compact path, and its own hop count as trailing text.
struct ConnectedRecordRow: View {
    let item: ConnectedRecord

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            NavigationLink(value: Route.entityDetail(item.target.entityKind, id: item.target.entityId)) {
                RecordListRow(
                    title: item.target.label,
                    symbol: EntityCatalog[item.target.entityKind].sfSymbol
                ) {
                    Text(EntityCatalog[item.target.entityKind].singular)
                } rail: {
                    Text(ConnectedPathPresentation.hopLabel(item.shortestHops))
                } supplement: {
                    EmptyView()
                }
            }
            RecordPathView(paths: item.paths)
        }
        .padding(.vertical, 2)
    }
}

/// The detail page's one Connected records section: each view with results as a titled group
/// with its first rows and an "N more" link to the complete list; empty views fold into one line.
struct ConnectedRecordsSection: View {
    let model: ConnectedRecordsPreviewModel

    var body: some View {
        ContinuousDetailSection(title: "Connected records") {
            if let error = model.error, model.preview == nil {
                InlineLoadFailure(message: error) { await model.refresh() }
            } else if let preview = model.preview {
                ConnectedRecordsPreviewContent(source: model.source, preview: preview)
            } else {
                LoadingIndicator(label: "Loading connected records")
            }
        }
        .task(id: model.source) { await model.loadInitial() }
    }
}

/// Plain-data rendering of a preview, shared by the live section and `#Preview`.
struct ConnectedRecordsPreviewContent: View {
    let source: EntityRef
    let preview: ConnectedRecordsPreviewOutput

    var body: some View {
        if !preview.hasConnections {
            Text("No connected records.").foregroundStyle(.secondary)
                .preference(key: DetailSectionEmpty.self, value: true)
        } else {
            ForEach(preview.views.filter { $0.totalCount > 0 }, id: \.viewKey) { view in
                HStack {
                    Text(view.title).font(.subheadline.weight(.semibold))
                    Spacer()
                    Text(view.totalCount, format: .number)
                        .font(.fieldGuideData).foregroundStyle(.secondary)
                }
                .accessibilityElement(children: .combine)
                ForEach(view.items, id: \.target.entityId) { item in
                    ConnectedRecordRow(item: item)
                }
                if view.totalCount > view.items.count {
                    NavigationLink(value: Route.connectedRecords(source, viewKey: view.viewKey)) {
                        Text("\(view.totalCount - view.items.count) more")
                    }
                    .accessibilityLabel("\(view.totalCount - view.items.count) more \(view.title)")
                }
            }
            let empty = preview.emptyViewTitles
            if !empty.isEmpty {
                Text("No connections: \(empty.joined(separator: ", "))")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
    }
}

/// One connected view's complete list, paged.
struct ConnectedRecordsListView: View {
    let source: EntityRef
    let viewKey: String

    @Environment(AppModel.self) private var appModel
    @State private var model: ConnectedSectionModel?

    private var spec: ConnectedViewSpec? {
        EntityCatalog[source.entity].presentation.connectedViews.first { $0.key == viewKey }
    }

    var body: some View {
        List {
            if let model {
                if let error = model.error {
                    InlineLoadFailure(message: error) { await model.refresh() }
                } else if !model.loaded {
                    LoadingIndicator(label: "Loading \(model.spec.title)")
                } else if model.items.isEmpty {
                    Text("No connected records.").foregroundStyle(.secondary)
                }
                ForEach(model.items, id: \.target.entityId) { ConnectedRecordRow(item: $0) }
                if model.hasMore {
                    Button("Load more") { Task { await model.loadNextPage() } }
                        .disabled(model.loading)
                }
            } else if spec == nil {
                ContentUnavailableView("Unknown connected view", systemImage: "link")
            }
        }
        .navigationTitle(spec?.title ?? "Connected records")
        #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
        #endif
        .task(id: "\(source.stableKey)/\(viewKey)") {
            guard let spec else { return }
            let next = ConnectedSectionModel(spec: spec, source: source, client: appModel.client)
            model = next
            await next.loadInitial()
        }
        .refreshable { await model?.refresh() }
    }
}

#Preview("Connected records") {
    NavigationStack {
        List {
            ConnectedRecordsPreviewContent(
                source: EntityRef(entity: .product, id: "PRD-4K7M"),
                preview: PreviewFixtures.decode(
                    #"""
                    {"views":[
                      {"viewKey":"recipes","title":"Recipes","targetEntity":"recipe","totalCount":5,
                       "items":[{"target":{"entityKind":"recipe","entityId":"RCP-2345","label":"Weeknight soup"},
                         "shortestHops":2,
                         "paths":[[{"entityKind":"product","entityId":"PRD-4K7M","label":"Oat milk"},
                                   {"entityKind":"ingredient","entityId":"ING-2345","label":"Oat milk"},
                                   {"entityKind":"recipe","entityId":"RCP-2345","label":"Weeknight soup"}]]}]},
                      {"viewKey":"projects","title":"Projects","targetEntity":"project","totalCount":0,"items":[]}
                    ]}
                    """#)
            )
        }
    }
}
