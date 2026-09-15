import CubbyKit
import SwiftUI

struct EntityListView: View {
    let key: EntityKey
    @Environment(AppModel.self) private var appModel
    @State private var model: GenericEntityListModel?
    init(key: EntityKey, model: GenericEntityListModel? = nil) {
        self.key = key
        _model = State(initialValue: model)
    }

    private var descriptor: EntityDescriptor { EntityCatalog[key] }

    var body: some View {
        Group {
            if let model {
                if model.rows.isEmpty {
                    switch model.phase {
                    case .idle, .loading:
                        LoadingIndicator.screen(label: "Loading \(descriptor.plural)")
                    case .unavailable(let message):
                        ContentUnavailableView(message, systemImage: entitySymbol(for: key))
                    case .failed(let message):
                        ContentUnavailableView {
                            Label(
                                "Couldn't load \(descriptor.plural)", systemImage: "exclamationmark.triangle")
                        } description: {
                            Text(message)
                        } actions: {
                            Button("Retry") { Task { await model.loadInitial() } }
                        }
                    case .loaded:
                        ContentUnavailableView(
                            "No \(descriptor.plural) yet", systemImage: entitySymbol(for: key))
                    }
                } else {
                    rowList(model)
                }
            } else {
                LoadingIndicator.screen(label: "Loading \(descriptor.plural)")
            }
        }
        .porcelainScreen()
        .navigationTitle(descriptor.plural)
        .accessibilityIdentifier("browse.\(key.rawValue).list")
        .task(id: key) {
            if model == nil {
                model = GenericEntityListModel(descriptor: descriptor, client: appModel.client)
            }
            await model?.loadInitial()
        }
        .task(id: appModel.relationshipMutationRevision) {
            guard appModel.relationshipMutationRevision > 0,
                appModel.relationshipMutationEntities.contains(key),
                model?.phase == .loaded
            else { return }
            await model?.refresh()
        }
        .refreshControl { await model?.refresh() }
    }

    private var selection: Binding<RecordSelection?>? {
        #if os(macOS)
            Binding(
                get: { appModel.navigator.selectedRecords[.browse] },
                set: { appModel.navigator.selectRecord($0, in: .browse) })
        #else
            nil
        #endif
    }

    private func rowList(_ model: GenericEntityListModel) -> some View {
        List(selection: selection) {
            if let error = model.refreshError {
                Section {
                    Text(error).foregroundStyle(.secondary)
                    Button("Retry refresh") { Task { await model.refresh() } }
                }
            }
            if let meta = model.meta {
                Text("\(meta.totalCount.formatted()) total · \(model.rows.count.formatted()) shown")
                    .font(.caption).foregroundStyle(.secondary)
            }
            ForEach(model.rows) { row in
                rowContent(row)
                    .contextMenu {
                        Button("Copy link", systemImage: "link") {
                            Clipboard.copy(appModel.webURL(for: row.id).absoluteString)
                        }
                        Button("Copy shortcode", systemImage: "number") { Clipboard.copy(row.id) }
                        ShareLink(item: appModel.webURL(for: row.id))
                    }
                    .accessibilityIdentifier("browse.\(key.rawValue).row.\(row.id)")
            }
            if model.hasMore {
                if let error = model.nextPageError { Text(error).foregroundStyle(.secondary) }
                Button {
                    Task { await model.loadNextPage() }
                } label: {
                    if model.activity == .loadingNextPage {
                        LoadingIndicator(label: "Loading more \(descriptor.plural)")
                    } else {
                        Text(model.nextPageError == nil ? "Load more" : "Retry loading more")
                    }
                }
                .disabled(model.activity != .idle)
                .accessibilityIdentifier("browse.\(key.rawValue).loadMore")
                // Scrolling to the row loads the next page; the button stays for retry after an error
                // (a failed page never auto-retries) and for VoiceOver.
                .onScrollVisibilityChange(threshold: 0.5) { visible in
                    guard visible, model.activity == .idle, model.nextPageError == nil else { return }
                    Task { await model.loadNextPage() }
                }
            }
        }
        .listStyle(.plain)
    }

    @ViewBuilder private func rowContent(_ row: EntityRow) -> some View {
        #if os(macOS)
            if appModel.navigator.section == .browse && appModel.navigator.browseKey == key {
                EntityRowView(key: key, row: row).tag(RecordSelection(key: key, id: row.id))
            } else {
                NavigationLink(value: Route.entityDetail(key, id: row.id)) {
                    EntityRowView(key: key, row: row)
                }
            }
        #else
            NavigationLink(value: Route.entityDetail(key, id: row.id)) {
                EntityRowView(key: key, row: row)
            }
        #endif
    }
}

/// Plain-data row rendering, shared by the real list and `#Preview`s so neither needs a network
/// round trip to render. The trailing fact is read straight off `raw` — whatever this entity's
/// list projection already carries, never an extra request.
struct EntityRowView: View {
    let key: EntityKey
    let row: EntityRow

    var body: some View {
        HStack(spacing: PorcelainTokens.Space.md) {
            Thumb(url: row.imageURL, size: 56, symbol: entitySymbol(for: key))
            VStack(alignment: .leading, spacing: 2) {
                Text(row.title)
                    .font(.body.weight(.semibold))
                    .foregroundStyle(PorcelainTokens.graphite)
                    .lineLimit(2)
                if let subtitle = row.subtitle, !subtitle.isEmpty {
                    Text(subtitle)
                        .font(.porcelainBody)
                        .foregroundStyle(PorcelainTokens.graphiteSecondary)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: PorcelainTokens.Space.sm)
            if let fact = EntityFacts.trailing(key: key, row: row) {
                Text(fact)
                    .font(.porcelainData)
                    .foregroundStyle(PorcelainTokens.graphiteSecondary)
                    .multilineTextAlignment(.trailing)
                    .lineLimit(2)
                    .layoutPriority(1)
            }
        }
        .padding(.vertical, PorcelainTokens.Space.xs)
        .frame(minHeight: 64)
    }
}

#Preview("Rows") {
    NavigationStack {
        List {
            ForEach(PreviewFixtures.sampleRows) { row in
                NavigationLink(value: Route.entityDetail(.product, id: row.id)) {
                    EntityRowView(key: .product, row: row)
                }
                .porcelainListRow()
            }
        }
        .listStyle(.plain)
        .porcelainScreen()
        .navigationTitle("Products")
    }
}
