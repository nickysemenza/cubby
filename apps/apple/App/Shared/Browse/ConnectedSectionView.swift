import CubbyKit
import SwiftUI

func recordHopLabel(min: Int, max: Int) -> String {
    min == max ? "\(min) record \(min == 1 ? "hop" : "hops")" : "\(min)–\(max) record hops"
}

struct RecordPathView: View {
    let paths: [[ConnectedPathNode]]

    var body: some View {
        if let shortest = paths.first {
            VStack(alignment: .leading, spacing: 5) {
                Text("\(shortest.count - 1) record \(shortest.count == 2 ? "hop" : "hops")")
                    .font(.caption.monospaced()).foregroundStyle(.secondary)
                path(shortest)
                if paths.count > 1 {
                    DisclosureGroup("\(paths.count - 1) other \(paths.count == 2 ? "path" : "paths")") {
                        ForEach(Array(paths.dropFirst().enumerated()), id: \.offset) { indexed in
                            path(indexed.element)
                        }
                    }
                    .font(.caption)
                }
            }
        }
    }

    private func path(_ nodes: [ConnectedPathNode]) -> some View {
        ScrollView(.horizontal) {
            HStack(spacing: 3) {
                ForEach(Array(nodes.dropFirst().enumerated()), id: \.offset) { indexed in
                    if indexed.offset > 0 { Text("→").foregroundStyle(.secondary) }
                    NavigationLink(
                        value: Route.entityDetail(indexed.element.entityType, id: indexed.element.entityId)
                    ) {
                        Text(indexed.element.label).lineLimit(1)
                    }
                }
            }
        }
        .scrollIndicators(.hidden)
    }
}

struct ConnectedSectionView: View {
    let model: ConnectedSectionModel

    var body: some View {
        Group {
            if !model.loaded || model.totalCount > 0 || model.error != nil {
                Section {
                    if let error = model.error {
                        Text(error).foregroundStyle(.secondary)
                        Button("Retry") { Task { await model.refresh() } }
                    } else if !model.loaded {
                        LoadingIndicator(label: "Loading \(model.spec.title)")
                    } else {
                        ForEach(model.items, id: \.target.entityId) { item in
                            VStack(alignment: .leading, spacing: 6) {
                                NavigationLink(
                                    value: Route.entityDetail(
                                        item.target.entityType, id: item.target.entityId)
                                ) {
                                    Text(item.target.label).font(.body.weight(.medium))
                                }
                                RecordPathView(paths: item.paths)
                            }
                            .padding(.vertical, 3)
                        }
                        if model.hasMore {
                            Button(model.expanded ? "Load more" : "Open all · \(model.totalCount) records") {
                                Task { await model.loadNextPage() }
                            }
                        }
                    }
                } header: {
                    HStack {
                        Text(model.spec.title)
                        if let range = model.hopRange {
                            Text(recordHopLabel(min: range.min, max: range.max))
                                .font(.caption.monospaced()).foregroundStyle(.secondary)
                        }
                    }
                }
            }
        }
        .task { await model.loadInitial() }
    }
}
