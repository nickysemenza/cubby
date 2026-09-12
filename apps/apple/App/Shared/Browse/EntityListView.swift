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
            .navigationTitle(descriptor.plural)
            .task(id: appModel.host) { await setup() }
            .refreshable { await reload() }
    }

    @ViewBuilder
    private var content: some View {
        if let model {
            switch model.phase {
            case .idle:
                ProgressView()
            case .loading:
                if loadedRows.isEmpty {
                    ProgressView()
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
            ProgressView()
        }
    }

    private func rowList(model: GenericEntityListModel) -> some View {
        List {
            ForEach(loadedRows) { row in
                NavigationLink(value: Route.entityDetail(key, id: row.id)) {
                    EntityRowView(row: row)
                }
            }
            if let meta = model.meta, meta.totalCount > loadedRows.count {
                Button {
                    Task { await loadMore() }
                } label: {
                    HStack {
                        Spacer()
                        if model.phase == .loading {
                            ProgressView()
                        } else {
                            Text("Load more")
                        }
                        Spacer()
                    }
                }
                .disabled(model.phase == .loading)
            }
        }
    }

    private func setup() async {
        let model = await GenericEntityListModel(descriptor: descriptor, client: appModel.client.raw)
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
/// round trip to render.
struct EntityRowView: View {
    let row: EntityRow

    var body: some View {
        HStack(spacing: PorcelainTokens.spacing * 1.5) {
            thumbnail
            VStack(alignment: .leading, spacing: 2) {
                Text(row.title).lineLimit(1)
                if let subtitle = row.subtitle {
                    Text(subtitle)
                        .font(.footnote)
                        .foregroundStyle(PorcelainTokens.graphiteSecondary)
                        .lineLimit(1)
                }
            }
        }
    }

    @ViewBuilder
    private var thumbnail: some View {
        if let url = row.imageURL {
            AsyncImage(url: url) { phase in
                if case .success(let image) = phase {
                    image.resizable().scaledToFill()
                } else {
                    placeholder
                }
            }
            .frame(width: 44, height: 44)
            .clipShape(RoundedRectangle(cornerRadius: PorcelainTokens.radiusSmall))
        } else {
            placeholder.frame(width: 44, height: 44)
        }
    }

    private var placeholder: some View {
        RoundedRectangle(cornerRadius: PorcelainTokens.radiusSmall)
            .fill(PorcelainTokens.inset)
            .overlay(Image(systemName: "photo").foregroundStyle(PorcelainTokens.graphiteSecondary))
    }
}

#Preview {
    NavigationStack {
        List {
            ForEach(PreviewFixtures.sampleRows) { row in
                NavigationLink(value: Route.entityDetail(.product, id: row.id)) {
                    EntityRowView(row: row)
                }
            }
        }
        .navigationTitle("Products")
    }
}
