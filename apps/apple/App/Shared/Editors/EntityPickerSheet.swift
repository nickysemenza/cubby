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
    private let injectedSource: EntityListPageSource?

    @Environment(AppModel.self) private var appModel
    @Environment(\.dismiss) private var dismiss
    @State private var term = ""
    @State private var selected: [EntityPick]
    @State private var model: GenericEntityListModel?
    @State private var resolution = RecordSelectionResolver()
    @State private var revealPending = true
    @State private var selectionOutsideScope = false
    @FocusState private var focusedResult: String?
    @FocusState private var searchFocused: Bool

    init(
        target: EntityKey, multiple: Bool = false, selected: [String] = [],
        scope: EntityPickerScope? = nil,
        source: EntityListPageSource? = nil, resolvedSelections: [EntityRow] = [],
        onPick: @escaping ([EntityPick]) -> Void
    ) {
        self.target = target
        self.multiple = multiple
        self.onPick = onPick
        self.scope = scope
        self.injectedSource = source
        let resolution = RecordSelectionResolver()
        for row in resolvedSelections { resolution.remember(row) }
        _resolution = State(initialValue: resolution)  // state-init-ok: sheet presentation
        // Every call site presents this via `.sheet(isPresented:)`, not `.sheet(item:)` —
        // dismissing tears the subtree down, so re-presenting rebuilds this seed fresh.
        _revealPending = State(initialValue: !multiple && !selected.isEmpty)
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
            ScrollViewReader { proxy in
                List {
                    if multiple {
                        Section("Selected (\(selected.count))") {
                            if selected.isEmpty { Text("No selections").foregroundStyle(.secondary) }
                            ForEach(selected, id: \.selectedRowIdentity) { pick in
                                HStack {
                                    selectionIdentity(pick.id)
                                    Spacer()
                                    Button {
                                        selected.removeAll { $0.id == pick.id }
                                    } label: {
                                        Image(systemName: "xmark.circle.fill")
                                            .frame(
                                                minWidth: selectionActionTarget,
                                                minHeight: selectionActionTarget
                                            )
                                            .contentShape(Rectangle())
                                    }
                                    .foregroundStyle(.secondary)
                                    .buttonStyle(.borderless)
                                    .accessibilityLabel(
                                        "Remove \(resolution.title(pick.id, descriptor: descriptor))")
                                }
                                .frame(minHeight: FieldGuideTokens.touchTarget)
                            }
                        }
                    }
                    if !multiple, let id = selected.first?.id {
                        if resolution.missing.contains(id) || resolution.errors[id] != nil {
                            Section { selectionIdentity(id) }
                        } else if selectionOutsideScope, resolution.rows[id] != nil {
                            Section {
                                Label(
                                    "\(resolution.title(id, descriptor: descriptor)) is outside the available options",
                                    systemImage: "info.circle"
                                )
                                .foregroundStyle(.secondary)
                            }
                        }
                    }
                    Section {
                        if let model {
                            if model.isSearching, let search = model.searchModel {
                                searchRows(search)
                            } else {
                                listRows(model)
                            }
                        }
                    }
                }
                .task(id: revealPage) { await revealCurrentSelection(using: proxy) }
                .onScrollPhaseChange { _, phase in
                    if phase == .tracking || phase == .interacting { revealPending = false }
                }
                .simultaneousGesture(DragGesture(minimumDistance: 2).onChanged { _ in revealPending = false })
                .listStyle(.plain)
                .fieldGuideScreen()
                .searchable(text: $term, prompt: "Search \(descriptor.plural)")
                .searchFocused($searchFocused)
                .onChange(of: searchFocused) { _, value in if value { revealPending = false } }
                .navigationTitle(multiple ? "Choose \(descriptor.plural)" : "Choose \(descriptor.singular)")
                #if os(iOS)
                    .navigationBarTitleDisplayMode(.inline)
                #endif
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction)
                    }
                    if multiple {
                        ToolbarItem(placement: .confirmationAction) {
                            Button("Done") {
                                onPick(
                                    selected.map { pick in
                                        EntityPick(
                                            id: pick.id,
                                            title: resolution.title(pick.id, descriptor: descriptor))
                                    })
                                dismiss()
                            }
                        }
                    }
                }
                .task(id: scope) {
                    let source = injectedSource ?? pageSource()
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
                .onChange(of: term) { _, value in
                    revealPending = false
                    model?.setSearchQuery(value)
                }
                .onChange(of: scope) { _, _ in revealPending = false }
                .onKeyPress(.downArrow) { moveFocus(by: 1) }
                .onKeyPress(.upArrow) { moveFocus(by: -1) }
                .onKeyPress(.return) {
                    guard let id = focusedResult, let row = visibleRows.first(where: { $0.id == id }) else {
                        return .ignored
                    }
                    choose(row)
                    return .handled
                }
                .task(id: selected.map(\.id)) {
                    await resolution.resolve(
                        selected.map(\.id), descriptor: descriptor, client: appModel.client)
                }
            }
        }
        .nativeSheet(.picker)
    }

    private var selectionActionTarget: CGFloat {
        #if os(iOS)
            FieldGuideTokens.touchTarget
        #else
            24
        #endif
    }

    private func selectionIdentity(_ id: String) -> some View {
        RecordSelectionIdentity(id: id, descriptor: descriptor, resolver: resolution) {
            await resolution.resolve([id], descriptor: descriptor, client: appModel.client, retry: true)
        }
    }

    // A completed page (including one containing only duplicate ids) advances the opening scan.
    // Search and member interaction permanently cancel it for this presentation.
    private var revealPage: Int? {
        guard revealPending, !multiple, term.isEmpty, model?.phase == .loaded else { return nil }
        return model?.page
    }

    private func revealCurrentSelection(using proxy: ScrollViewProxy) async {
        guard revealPending, !multiple, term.isEmpty, let id = selected.first?.id,
            let model, model.phase == .loaded
        else { return }
        if model.rows.contains(where: { $0.id == id }) {
            revealPending = false
            proxy.scrollTo(EntityPickerRowIdentity.result(id), anchor: .center)
        } else if model.hasMore, model.nextPageError == nil {
            await model.loadNextPage()
        } else if !model.hasMore {
            revealPending = false
            selectionOutsideScope = scope != nil
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
            InlineLoadFailure(message: message) {
                revealPending = false
                await model.loadInitial()
            }
        case .loaded:
            if model.rows.isEmpty { Text("No matches").foregroundStyle(.secondary) }
            ForEach(model.rows, id: \.entityPickerResultIdentity) { row in
                pickRow(row)
            }
            if let message = model.refreshError {
                InlineLoadFailure(message: message, isRetrying: model.activity != .idle) {
                    revealPending = false
                    await model.refresh()
                }
            }
            if let message = model.nextPageError {
                InlineLoadFailure(message: message, isRetrying: model.activity != .idle) {
                    revealPending = false
                    await model.loadNextPage()
                }
            }
            if model.hasMore && model.nextPageError == nil {
                Button("Load more") {
                    revealPending = false
                    Task { await model.loadNextPage() }
                }
                .disabled(model.activity != .idle)
            }
        }
    }

    private func pickRow(_ row: EntityRow) -> some View {
        let isSelected = selected.contains { $0.id == row.id }
        return Button {
            choose(row)
        } label: {
            RecordListRow(
                title: row.title == row.id
                    || row.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    ? "Unnamed \(descriptor.singular)" : row.title,
                imageURL: row.imageURL, symbol: descriptor.recordSymbol(in: row),
                emoji: descriptor.recordEmoji(in: row), titleLineLimit: 2
            ) {
                VStack(alignment: .leading, spacing: 2) {
                    if let status = EntityRowPresentation.status(descriptor: descriptor, row: row) {
                        Label(status.text, systemImage: status.option?.glyph?.sfSymbol ?? "circle.fill")
                            .foregroundStyle(
                                FieldGuideMetrics.optionColor(status.option?.color) ?? .secondary)
                    }
                    if let subtitle = row.subtitle, subtitle != row.id { Text(subtitle) }
                    let values = EntityRowPresentation.rail(descriptor: descriptor, row: row)
                        .compactMap { cell in cell.value.map { "\(cell.label): \($0)" } }
                    if !values.isEmpty { Text(values.joined(separator: " · ")) }
                }
            } rail: {
                if isSelected {
                    Image(systemName: "checkmark").foregroundStyle(FieldGuideTokens.interaction)
                }
            } supplement: {
                EmptyView()
            }
        }
        .buttonStyle(.plain)
        .id(row.entityPickerResultIdentity)
        .focused($focusedResult, equals: row.id)
        .accessibilityIdentifier("picker.option.\(row.id)")
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }

    private var visibleRows: [EntityRow] {
        if let model, model.isSearching { return model.searchModel?.rows ?? [] }
        return model?.rows ?? []
    }

    private func moveFocus(by offset: Int) -> KeyPress.Result {
        revealPending = false
        let rows = visibleRows
        guard !rows.isEmpty else { return .ignored }
        let index = focusedResult.flatMap { id in rows.firstIndex(where: { $0.id == id }) }
        let next = index.map { min(max($0 + offset, 0), rows.count - 1) } ?? (offset > 0 ? 0 : rows.count - 1)
        focusedResult = rows[next].id
        return .handled
    }

    private func choose(_ row: EntityRow) {
        revealPending = false
        resolution.remember(row)
        let pick = EntityPick(id: row.id, title: resolution.title(row.id, descriptor: descriptor))
        if multiple {
            if selected.contains(where: { $0.id == row.id }) {
                selected.removeAll { $0.id == row.id }
            } else {
                selected.append(pick)
            }
        } else {
            onPick([pick])
            dismiss()
        }
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
                guard ready else { return emptyPage(page) }
                return try await client.list(
                    descriptor, page: page, pageSize: 25, filters: filters)
            },
            searchPage: { query, page in
                guard ready else { return emptyPage(page) }
                if searchRPC {
                    do {
                        let hits = try await client.search(
                            query, kinds: [target], limit: 25, offset: (page - 1) * 25)
                        let rows = hits.map {
                            EntityRow(
                                id: $0.id, title: $0.title, subtitle: $0.context, imageURL: $0.imageURL,
                                raw: .object([
                                    "emoji": $0.emoji.valueIfPresent.flatMap { $0 }.map(JSONValue.string)
                                        ?? .null
                                ]))
                        }
                        return ListPage(
                            items: rows,
                            meta: ListPageMeta(
                                pageIndex: page, pageSize: 25,
                                totalCount: (page - 1) * 25 + rows.count + (rows.count == 25 ? 1 : 0),
                                hasNextPage: rows.count == 25))
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

/// The production picker and paginator with synthetic reads; no preview network or new renderer.
private struct EntityPickerPreview: View {
    var multiple = false
    private var target: EntityKey { multiple ? .project : .vendor }
    private var rows: [EntityRow] {
        let names =
            multiple
            ? ["Kitchen refresh", "Spring planting and greenhouse improvements", "Tool maintenance"]
            : ["Acorn Supply", "Birch Workshop — Tools and Garden Supplies", "Cedar Goods"]
        return names.enumerated().map { index, title in
            EntityRow(
                id: "synthetic-choice-\(index)", title: title,
                subtitle: multiple ? "Household project" : "Tools and supplies", imageURL: nil,
                raw: .object(["name": .string(title), "emoji": .string(multiple ? "🌱" : "🧰")]))
        }
    }

    var body: some View {
        let rows = rows
        EntityPickerSheet(
            target: target, multiple: multiple,
            selected: multiple ? Array(rows.prefix(2).map(\.id)) : [rows[1].id],
            source: EntityListPageSource(id: "picker-preview") { _ in
                ListPage(
                    items: rows,
                    meta: ListPageMeta(pageIndex: 1, pageSize: 25, totalCount: rows.count, hasNextPage: false)
                )
            } searchPage: { query, _ in
                let matches = rows.filter { $0.title.localizedCaseInsensitiveContains(query) }
                return ListPage(
                    items: matches,
                    meta: ListPageMeta(
                        pageIndex: 1, pageSize: 25, totalCount: matches.count, hasNextPage: false))
            }, resolvedSelections: rows
        ) { _ in }
        .environment(PreviewFixtures.signedInModel())
    }
}

#Preview("Choose Vendor") { EntityPickerPreview() }
#Preview("Choose Projects") { EntityPickerPreview(multiple: true) }
#Preview("Choose Projects — large text") {
    EntityPickerPreview(multiple: true).dynamicTypeSize(.accessibility3)
}
#Preview("Choose Vendor — dark") { EntityPickerPreview().preferredColorScheme(.dark) }
