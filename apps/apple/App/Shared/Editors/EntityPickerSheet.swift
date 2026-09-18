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
/// The search term drives the target's first text filter; a target without one (planting) goes
/// through `search.find` when it is indexed, else the picker lists the target unfiltered.
struct EntityPickerSheet: View {
    let target: EntityKey
    let multiple: Bool
    let onPick: ([EntityPick]) -> Void

    @Environment(AppModel.self) private var appModel
    @Environment(\.dismiss) private var dismiss
    @State private var term = ""
    @State private var selected: [EntityPick]
    @State private var model: GenericEntityListModel?
    @State private var hits: [EntityPick] = []
    @State private var searchError: String?
    @State private var isSearching = false
    private let debouncer = SearchDebouncer()

    init(
        target: EntityKey, multiple: Bool = false, selected: [String] = [],
        onPick: @escaping ([EntityPick]) -> Void
    ) {
        self.target = target
        self.multiple = multiple
        self.onPick = onPick
        // Every call site presents this via `.sheet(isPresented:)`, not `.sheet(item:)` —
        // dismissing tears the subtree down, so re-presenting rebuilds this seed fresh.
        _selected = State(initialValue: selected.map { EntityPick(id: $0, title: $0) })  // state-init-ok
    }

    private var descriptor: EntityDescriptor { EntityCatalog[target] }
    private var textFilter: FilterDescriptor? { descriptor.filters.first { $0.kind == .text } }
    private var usesSearchRPC: Bool { textFilter == nil && descriptor.searchable }

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
                            .frame(minHeight: PorcelainTokens.touchTarget)
                        }
                    }
                }
                Section {
                    if usesSearchRPC {
                        searchRows
                    } else if let model {
                        listRows(model)
                    }
                }
            }
            .listStyle(.plain)
            .porcelainScreen()
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
            .task {
                await reload(term: "")
                for await value in debouncer.values() {
                    await reload(term: value)
                }
            }
            .onChange(of: term) { _, value in debouncer.send(value) }
        }
        .nativeSheet(.picker)
    }

    @ViewBuilder
    private var searchRows: some View {
        if isSearching { LoadingIndicator(label: "Searching") }
        if let searchError { Text(searchError).foregroundStyle(.secondary) }
        if hits.isEmpty, !isSearching, searchError == nil {
            Text(term.isEmpty ? "Type to search" : "No matches").foregroundStyle(.secondary)
        }
        ForEach(hits, id: \.resultRowIdentity) { hit in
            pickRow(hit, imageURL: nil)
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
                pickRow(EntityPick(id: row.id, title: row.title), imageURL: row.imageURL)
            }
            if model.hasMore {
                Button("Load more") { Task { await model.loadNextPage() } }
                    .disabled(model.activity != .idle)
            }
        }
    }

    private func pickRow(_ pick: EntityPick, imageURL: URL?) -> some View {
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
            HStack(spacing: PorcelainTokens.Space.md) {
                Thumb(url: imageURL, size: 40, symbol: descriptor.sfSymbol)
                VStack(alignment: .leading, spacing: 2) {
                    Text(pick.title).foregroundStyle(PorcelainTokens.graphite)
                    Text(pick.id).font(.porcelainCode).foregroundStyle(.secondary)
                }
                Spacer()
                if isSelected {
                    Image(systemName: "checkmark").foregroundStyle(PorcelainTokens.cobalt)
                }
            }
            .frame(minHeight: PorcelainTokens.touchTarget)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }

    private func reload(term: String) async {
        if usesSearchRPC {
            guard !term.isEmpty else {
                hits = []
                return
            }
            isSearching = true
            defer { isSearching = false }
            do {
                let results = try await appModel.client.search(term, kinds: [target], limit: 25)
                hits = results.map { EntityPick(id: $0.id, title: $0.title) }
                searchError = nil
            } catch {
                searchError = (error as? CubbyAPIError)?.detail?.message ?? String(describing: error)
                Diagnostics.report(error, context: "picker.search")
            }
            return
        }
        var filters = EntityFilterState()
        if let textFilter, case .param(let name) = textFilter.wire {
            filters.set(.single(term), for: name)
        }
        let fresh = GenericEntityListModel(
            descriptor: descriptor, client: appModel.client, pageSize: 25, filters: filters, view: .table)
        model = fresh
        await fresh.loadInitial()
    }
}

#Preview("Pick a location") {
    EntityPickerSheet(target: .location) { _ in }
        .environment(PreviewFixtures.signedInModel())
}
