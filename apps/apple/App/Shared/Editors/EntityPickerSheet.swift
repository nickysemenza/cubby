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
    @State private var selectionRows: [String: EntityRow] = [:]
    @State private var missingSelections: Set<String> = []
    @State private var selectionErrors: [String: String] = [:]

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
                    Section(multiple ? "Selected (\(selected.count))" : "Current selection") {
                        ForEach(selected, id: \.selectedRowIdentity) { pick in
                            HStack {
                                selectedIdentity(pick)
                                Spacer()
                                if multiple {
                                    Button("Remove", systemImage: "xmark.circle.fill") {
                                        selected.removeAll { $0.id == pick.id }
                                    }
                                    .labelStyle(.iconOnly)
                                    .foregroundStyle(.secondary)
                                    .buttonStyle(.borderless)
                                    .accessibilityLabel("Remove \(selectionTitle(pick.id))")
                                }
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
            .task(id: selected.map(\.id)) { await resolveSelections() }
        }
        .nativeSheet(.picker)
    }

    @ViewBuilder
    private func selectedIdentity(_ pick: EntityPick) -> some View {
        if let row = selectionRows[pick.id] {
            HStack(spacing: FieldGuideTokens.Space.sm) {
                Thumb(
                    url: row.imageURL, size: RecordRowMetrics.thumbnail,
                    symbol: descriptor.recordSymbol(in: row), emoji: descriptor.recordEmoji(in: row))
                Text(selectionTitle(row.id))
                    .fixedSize(horizontal: false, vertical: true)
            }
        } else if missingSelections.contains(pick.id) {
            Label("\(descriptor.singular) no longer available", systemImage: "questionmark.folder")
                .foregroundStyle(.secondary)
        } else if let message = selectionErrors[pick.id] {
            InlineLoadFailure(message: message) {
                await resolveSelections(retrying: pick.id)
            }
        } else {
            LoadingIndicator(label: "Loading selection")
        }
    }

    private func selectionTitle(_ id: String) -> String {
        guard let row = selectionRows[id], row.title != row.id else {
            return "Unnamed \(descriptor.singular)"
        }
        return row.title
    }

    private func resolveSelections(retrying retryID: String? = nil) async {
        let ids = retryID.map { [$0] } ?? selected.map(\.id)
        for id in ids {
            guard !Task.isCancelled else { return }
            if retryID == nil && (selectionRows[id] != nil || missingSelections.contains(id)) {
                continue
            }
            selectionErrors[id] = nil
            do {
                let row = try await appModel.client.row(descriptor, id: id)
                try Task.checkCancellation()
                guard selected.contains(where: { $0.id == id }) else { continue }
                if let row {
                    selectionRows[id] = row
                    if let index = selected.firstIndex(where: { $0.id == id }) {
                        selected[index] = EntityPick(id: id, title: row.title)
                    }
                } else {
                    missingSelections.insert(id)
                }
            } catch {
                guard !Task.isCancelled else { return }
                Diagnostics.report(error, context: "picker.selection")
                selectionErrors[id] = error.userMessage
            }
        }
    }

    @ViewBuilder
    private func searchRows(_ search: EntityListSearchModel) -> some View {
        switch search.phase {
        case .idle: EmptyView()
        case .debouncing, .loading: LoadingIndicator(label: "Searching")
        case .failed(let message):
            InlineLoadFailure(message: message) { search.retry() }
        case .loaded:
            if search.rows.isEmpty { Text("No matches").foregroundStyle(.secondary) }
        }
        ForEach(search.rows, id: \.entityPickerResultIdentity) { row in
            pickRow(row)
        }
        if let message = search.refreshError {
            InlineLoadFailure(message: message) { await search.refresh() }
        }
        if let message = search.nextPageError {
            InlineLoadFailure(message: message) { await search.loadNextPage() }
        }
        if search.hasMore && search.nextPageError == nil {
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
            InlineLoadFailure(message: message) { await model.loadInitial() }
        case .loaded:
            if model.rows.isEmpty { Text("No matches").foregroundStyle(.secondary) }
            ForEach(model.rows, id: \.entityPickerResultIdentity) { row in
                pickRow(row)
            }
            if let message = model.refreshError {
                InlineLoadFailure(message: message, isRetrying: model.activity != .idle) {
                    await model.refresh()
                }
            }
            if let message = model.nextPageError {
                InlineLoadFailure(message: message, isRetrying: model.activity != .idle) {
                    await model.loadNextPage()
                }
            }
            if model.hasMore && model.nextPageError == nil {
                Button("Load more") { Task { await model.loadNextPage() } }
                    .disabled(model.activity != .idle)
            }
        }
    }

    private func pickRow(_ row: EntityRow) -> some View {
        let pick = EntityPick(id: row.id, title: row.title)
        let isSelected = selected.contains { $0.id == pick.id }
        return Button {
            selectionRows[row.id] = row
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
            RecordListRow(
                title: row.title == row.id ? "Unnamed \(descriptor.singular)" : row.title,
                imageURL: row.imageURL, symbol: descriptor.recordSymbol(in: row),
                emoji: descriptor.recordEmoji(in: row), titleLineLimit: 2
            ) {
                if let subtitle = row.subtitle { Text(subtitle) }
            } rail: {
                if isSelected {
                    Image(systemName: "checkmark").foregroundStyle(FieldGuideTokens.interaction)
                }
            } supplement: {
                EmptyView()
            }
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("picker.option.\(row.id)")
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
            ListPage(
                items: [],
                meta: ListPageMeta(pageIndex: page, pageSize: 25, totalCount: 0, hasNextPage: false))
        }
        return EntityListPageSource(
            id: scope,
            loadPage: { page in
                guard ready, !searchRPC else { return emptyPage(page) }
                return try await client.list(
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
                            meta: ListPageMeta(
                                pageIndex: page, pageSize: 25, totalCount: rows.count, hasNextPage: false))
                    } catch {
                        await MainActor.run { Diagnostics.report(error, context: "picker.search") }
                        throw error
                    }
                }
                // Search stays on the scoped list route; a global search would widen candidates.
                var scopedFilters = filters
                if let searchKey { scopedFilters.set([query], for: searchKey) }
                return try await client.list(
                    descriptor, page: page, pageSize: 25, filters: scopedFilters)
            })
    }
}

#Preview("Pick a location") {
    EntityPickerSheet(target: .location) { _ in }
        .environment(PreviewFixtures.signedInModel())
}
