import CubbyKit
import SwiftUI

/// One chosen record: the id the field stores and the title the editor shows beside it.
struct EntityPick: Hashable, Identifiable {
    let id: String
    let title: String

    var selectedRowIdentity: EntityPickerRowIdentity { .selected(id) }
    var resultRowIdentity: EntityPickerRowIdentity { .result(id) }
}

/// A record can appear in both the selected and result sections; the section is therefore part
/// of its SwiftUI identity even though both rows represent the same stored record.
enum EntityPickerRowIdentity: Hashable {
    case selected(String)
    case result(String)
}

private extension EntityRow {
    var entityPickerResultIdentity: EntityPickerRowIdentity { .result(id) }
}

/// A searchable picker over one entity, for `id`/`idMulti` filters and `entity-select` controls.
/// Search uses the declared primary search key without replacing dependent scope filters.
/// An unscoped indexed target without a list search key uses `search.find`.
struct EntityPickerSheet: View {
    let target: EntityKey
    let multiple: Bool
    let onPick: ([EntityPick]) -> Void
    let scope: EntityPickerScope?

    @Environment(AppModel.self) private var appModel
    @Environment(\.dismiss) private var dismiss
    @State private var term = ""
    @State private var selected: [EntityPick]
    @State private var model: GenericEntityListModel?

    init(
        target: EntityKey, multiple: Bool = false, selected: [String] = [],
        scope: EntityPickerScope? = nil,
        onPick: @escaping ([EntityPick]) -> Void
    ) {
        self.target = target
        self.multiple = multiple
        self.onPick = onPick
        self.scope = scope
        // Every call site presents this via `.sheet(isPresented:)`, not `.sheet(item:)` —
        // dismissing tears the subtree down, so re-presenting rebuilds this seed fresh.
        _selected = State(initialValue: selected.map { EntityPick(id: $0, title: $0) })  // state-init-ok
    }

    private var descriptor: EntityDescriptor { EntityCatalog[target] }
    private var searchKey: String? {
        if let primarySearch = descriptor.primarySearch { return primarySearch.key }
        if let textFilter = descriptor.filters.first(where: { $0.kind == .text }),
            case .param(let name) = textFilter.wire
        {
            return name
        }
        return nil
    }
    private var usesSearchRPC: Bool {
        searchKey == nil && descriptor.searchable && scope == nil
    }

    var body: some View {
        NavigationStack {
            List {
                if !selected.isEmpty {
                    Section("Selected") {
                        ForEach(selected, id: \.selectedRowIdentity) { pick in
                            HStack {
                                Text(pick.title)
                                Spacer()
                                Button("Remove", systemImage: "xmark.circle.fill") {
                                    selected.removeAll { $0.id == pick.id }
                                }
                                .labelStyle(.iconOnly)
                                .foregroundStyle(.secondary)
                                .buttonStyle(.borderless)
                            }
                            .frame(minHeight: FieldGuideTokens.touchTarget)
                        }
                    }
                }
                Section {
                    if let model {
                        if model.isSearching, let search = model.searchModel {
                            searchRows(search)
                        } else if usesSearchRPC {
                            Text("Type to search").foregroundStyle(.secondary)
                        } else {
                            listRows(model)
                        }
                    }
                }
            }
            .listStyle(.plain)
            .fieldGuideScreen()
            .searchable(text: $term, prompt: "Search \(descriptor.plural)")
            .navigationTitle(multiple ? "Choose \(descriptor.plural)" : "Choose \(descriptor.singular)")
            #if os(iOS)
                .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                if multiple {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Done") {
                            onPick(selected)
                            dismiss()
                        }
                    }
                }
            }
            .task(id: scope) {
                let source = pageSource()
                if let model {
                    await model.setSource(source)
                    await model.loadInitial()
                } else {
                    let fresh = GenericEntityListModel(
                        descriptor: descriptor, client: appModel.client, source: source)
                    model = fresh
                    fresh.setSearchQuery(term)
                    await fresh.loadInitial()
                }
            }
            .onChange(of: term) { _, value in model?.setSearchQuery(value) }
        }
        .nativeSheet(.picker)
    }

    @ViewBuilder
    private func searchRows(_ search: EntityListSearchModel) -> some View {
        switch search.phase {
        case .idle: EmptyView()
        case .debouncing, .loading: LoadingIndicator(label: "Searching")
        case .failed(let message): Text(message).foregroundStyle(.secondary)
        case .loaded:
            if search.rows.isEmpty { Text("No matches").foregroundStyle(.secondary) }
        }
        ForEach(search.rows, id: \.entityPickerResultIdentity) { row in
            pickRow(
                EntityPick(id: row.id, title: row.title), imageURL: row.imageURL,
                emoji: descriptor.recordEmoji(in: row))
        }
        if let message = search.nextPageError { Text(message).foregroundStyle(.secondary) }
        if search.hasMore {
            Button("Load more") { Task { await search.loadNextPage() } }
                .disabled(search.phase != .loaded)
        }
    }

    @ViewBuilder
    private func listRows(_ model: GenericEntityListModel) -> some View {
        switch model.phase {
        case .idle, .loading:
            LoadingIndicator(label: "Loading \(descriptor.plural)")
        case .unavailable(let message), .failed(let message):
            Text(message).foregroundStyle(.secondary)
        case .loaded:
            if model.rows.isEmpty { Text("No matches").foregroundStyle(.secondary) }
            ForEach(model.rows, id: \.entityPickerResultIdentity) { row in
                pickRow(
                    EntityPick(id: row.id, title: row.title), imageURL: row.imageURL,
                    emoji: descriptor.recordEmoji(in: row))
            }
            if model.hasMore {
                Button("Load more") { Task { await model.loadNextPage() } }
                    .disabled(model.activity != .idle)
            }
        }
    }

    private func pickRow(_ pick: EntityPick, imageURL: URL?, emoji: String? = nil) -> some View {
        let isSelected = selected.contains { $0.id == pick.id }
        return Button {
            if multiple {
                if isSelected {
                    selected.removeAll { $0.id == pick.id }
                } else {
                    selected.append(pick)
                }
            } else {
                onPick([pick])
                dismiss()
            }
        } label: {
            HStack(spacing: FieldGuideTokens.Space.md) {
                Thumb(url: imageURL, size: 40, symbol: descriptor.sfSymbol, emoji: emoji)
                VStack(alignment: .leading, spacing: 2) {
                    Text(pick.title).foregroundStyle(FieldGuideTokens.graphite)
                    Text(pick.id).font(.fieldGuideCode).foregroundStyle(.secondary)
                }
                Spacer()
                if isSelected {
                    Image(systemName: "checkmark").foregroundStyle(FieldGuideTokens.interaction)
                }
            }
            .frame(minHeight: FieldGuideTokens.touchTarget)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }

    private func pageSource() -> EntityListPageSource {
        let client = appModel.client
        let descriptor = descriptor
        let target = target
        let scope = scope
        let filters = scope?.filters ?? EntityFilterState()
        let ready = scope?.ready ?? true
        let searchRPC = usesSearchRPC
        let searchKey = searchKey
        let emptyPage: @Sendable (Int) -> ListPage<EntityRow> = { page in
            ListPage(items: [], meta: ListPageMeta(pageIndex: page, pageSize: 25, totalCount: 0))
        }
        return EntityListPageSource(
            id: scope,
            enrichesRows: !searchRPC,
            loadPage: { page in
                guard ready, !searchRPC else { return emptyPage(page) }
                return try await client.progressiveList(
                    descriptor, page: page, pageSize: 25, filters: filters)
            },
            searchPage: { query, page in
                guard ready else { return emptyPage(page) }
                if searchRPC {
                    do {
                        let hits = try await client.search(query, kinds: [target], limit: 25)
                        let rows = hits.map {
                            EntityRow(
                                id: $0.id, title: $0.title, subtitle: nil, imageURL: nil, raw: .null)
                        }
                        return ListPage(
                            items: page == 1 ? rows : [],
                            meta: ListPageMeta(pageIndex: page, pageSize: 25, totalCount: rows.count))
                    } catch {
                        await MainActor.run { Diagnostics.report(error, context: "picker.search") }
                        throw error
                    }
                }
                // Search stays on the scoped list route; a global search would widen candidates.
                var scopedFilters = filters
                if let searchKey { scopedFilters.set(.single(query), for: searchKey) }
                return try await client.progressiveList(
                    descriptor, page: page, pageSize: 25, filters: scopedFilters)
            })
    }
}

#Preview("Pick a location") {
    EntityPickerSheet(target: .location) { _ in }
        .environment(PreviewFixtures.signedInModel())
}
