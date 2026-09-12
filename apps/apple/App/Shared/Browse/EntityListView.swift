import CubbyKit
import SwiftUI

/// One entity's list screen. Owns a `GenericEntityListModel` created per host (mirrors
/// `CaptureView`/`CaptureModel`), and accumulates pages into view state since the model itself
/// replaces `rows` with whichever page was last requested.
struct EntityListView: View {
    let key: EntityKey

    @Environment(AppModel.self) private var appModel
    @State private var model: GenericEntityListModel?
    @State private var loadedRows: [EntityRow] = []

    private var descriptor: EntityDescriptor { EntityCatalog[key] }

    var body: some View {
        content
            .porcelainScreen()
            .navigationTitle(descriptor.plural)
            .task(id: appModel.host) { await setup() }
            .refreshable { await reload() }
    }

    @ViewBuilder
    private var content: some View {
        if let model {
            switch model.phase {
            case .idle:
                loading
            case .loading:
                if loadedRows.isEmpty {
                    loading
                } else {
                    rowList(model: model)
                }
            case .unavailable(let message):
                ContentUnavailableView(message, systemImage: entitySymbol(for: key))
            case .failed(let message):
                if loadedRows.isEmpty {
                    ContentUnavailableView(
                        "Couldn't load \(descriptor.plural)",
                        systemImage: "exclamationmark.triangle",
                        description: Text(message)
                    )
                } else {
                    rowList(model: model)
                }
            case .loaded:
                if loadedRows.isEmpty {
                    ContentUnavailableView("No \(descriptor.plural) yet", systemImage: entitySymbol(for: key))
                } else {
                    rowList(model: model)
                }
            }
        } else {
            loading
        }
    }

    private var loading: some View {
        ProgressView()
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(PorcelainTokens.canvas)
    }

    private func rowList(model: GenericEntityListModel) -> some View {
        List {
            if let meta = model.meta {
                Eyebrow(countLabel(total: meta.totalCount))
                    .padding(.top, PorcelainTokens.Space.md)
                    .padding(.bottom, PorcelainTokens.Space.xs)
                    .listRowInsets(
                        EdgeInsets(
                            top: 0, leading: PorcelainTokens.Space.lg,
                            bottom: 0, trailing: PorcelainTokens.Space.lg
                        )
                    )
                    .listRowBackground(PorcelainTokens.canvas)
                    .listRowSeparator(.hidden)
            }
            ForEach(loadedRows) { row in
                NavigationLink(value: Route.entityDetail(key, id: row.id)) {
                    EntityRowView(key: key, row: row)
                }
                .porcelainListRow()
            }
            if let meta = model.meta, meta.totalCount > loadedRows.count {
                Button {
                    Task { await loadMore() }
                } label: {
                    HStack {
                        Spacer()
                        if model.phase == .loading {
                            ProgressView().controlSize(.small)
                        } else {
                            Text("Load \(min(50, meta.totalCount - loadedRows.count)) more")
                                .font(.porcelainTitle)
                                .foregroundStyle(PorcelainTokens.cobalt)
                        }
                        Spacer()
                    }
                    .frame(minHeight: PorcelainTokens.touchTarget)
                }
                .buttonStyle(.plain)
                .disabled(model.phase == .loading)
                .porcelainListRow()
                .listRowSeparator(.hidden)
            }
        }
        .listStyle(.plain)
    }

    private func countLabel(total: Int) -> String {
        let noun = total == 1 ? descriptor.singular.lowercased() : descriptor.plural.lowercased()
        return "\(total.formatted()) \(noun) · showing \(loadedRows.count.formatted())"
    }

    private func setup() async {
        let model = GenericEntityListModel(descriptor: descriptor, client: appModel.client)
        self.model = model
        await model.load(page: 1)
        loadedRows = model.rows
    }

    private func reload() async {
        guard let model else { return }
        await model.load(page: 1)
        loadedRows = model.rows
    }

    private func loadMore() async {
        guard let model, model.phase != .loading else { return }
        let nextPage = model.page + 1
        await model.load(page: nextPage)
        guard model.phase == .loaded else { return }
        loadedRows.append(contentsOf: model.rows)
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
