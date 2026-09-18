import CubbyKit
import SwiftUI

/// The typed view of one `EntityFilterState` through a descriptor's filters: each control kind
/// reads and writes its wire parameter(s) here, so the sheet's controls and a test speak the same
/// mapping (`FilterDescriptor` + control value → `EntityFilterState`).
struct EntityFilterDraft: Hashable {
    var state: EntityFilterState

    init(_ state: EntityFilterState = EntityFilterState()) {
        self.state = state
    }

    /// `text`, `select`, `id`: the one string under the parameter, empty when unset.
    func single(_ filter: FilterDescriptor) -> String {
        guard case .param(let name) = filter.wire else { return "" }
        return state[name]?.strings.first ?? ""
    }

    mutating func setSingle(_ value: String, for filter: FilterDescriptor) {
        guard case .param(let name) = filter.wire else { return }
        state.set(.single(value), for: name)
    }

    /// `multiselect`, `idMulti`: the array under the parameter.
    func many(_ filter: FilterDescriptor) -> [String] {
        guard case .param(let name) = filter.wire else { return [] }
        return state[name]?.strings ?? []
    }

    mutating func setMany(_ values: [String], for filter: FilterDescriptor) {
        guard case .param(let name) = filter.wire else { return }
        state.set(.many(values), for: name)
    }

    /// `range`: the `from`/`to` bounds and the presence arm, each empty when unset.
    struct Range: Hashable {
        var from = ""
        var to = ""
        var presence = ""

        init(from: String = "", to: String = "", presence: String = "") {
            self.from = from
            self.to = to
            self.presence = presence
        }
    }

    func range(_ filter: FilterDescriptor) -> Range {
        guard case .range(let from, let to, let presence) = filter.wire else { return Range() }
        return Range(
            from: state[from]?.strings.first ?? "",
            to: state[to]?.strings.first ?? "",
            presence: presence.flatMap { state[$0]?.strings.first } ?? "")
    }

    mutating func setRange(_ range: Range, for filter: FilterDescriptor) {
        guard case .range(let from, let to, let presence) = filter.wire else { return }
        state.set(.single(range.from), for: from)
        state.set(.single(range.to), for: to)
        if let presence { state.set(.single(range.presence), for: presence) }
    }

    /// Whether any of the filter's parameters carry a value.
    func isActive(_ filter: FilterDescriptor) -> Bool {
        filter.wire.names.contains { state[$0] != nil }
    }

    mutating func clear(_ filter: FilterDescriptor) {
        for name in filter.wire.names { state.remove(name) }
    }

    /// A `range` filter edits dates when its column is a date/timestamp field, else numbers.
    static func rangeIsDates(_ filter: FilterDescriptor, in descriptor: EntityDescriptor) -> Bool {
        guard let field = descriptor.field(filter.columnId) else {
            return filter.columnId.hasSuffix("At") || filter.columnId.hasSuffix("Date")
                || filter.columnId.hasSuffix("On")
        }
        return field.kind == .date || field.kind == .timestamp
    }

    /// The choices a `select`/`multiselect` offers: declared `options`, else the list route's
    /// enum values under the wire name.
    struct Option: Hashable, Identifiable {
        let value: String
        let label: String
        var id: String { value }
    }

    static func options(for filter: FilterDescriptor, in descriptor: EntityDescriptor) -> [Option] {
        if let options = filter.options { return options.map { Option(value: $0.value, label: $0.label) } }
        guard case .param(let name) = filter.wire, let values = descriptor.filterValues(for: name) else {
            return []
        }
        return values.map {
            Option(value: $0, label: $0.replacingOccurrences(of: "_", with: " ").capitalized)
        }
    }

    static func label(for filter: FilterDescriptor, in descriptor: EntityDescriptor) -> String {
        if let label = filter.label { return label }
        if let field = descriptor.field(filter.columnId) { return field.label }
        let stripped = filter.placeholder.replacingOccurrences(of: "...", with: "")
        if stripped.lowercased().hasPrefix("filter by ") { return String(stripped.dropFirst(10)).capitalized }
        if stripped.lowercased().hasPrefix("filter ") { return String(stripped.dropFirst(7)).capitalized }
        return stripped.isEmpty ? filter.columnId : stripped
    }
}

/// Every declared filter of one entity as a form, applied in one go. The eight `EntityFilterKind`s
/// map to native controls; a filter the sheet cannot edit (an id picker whose target has no
/// descriptor) is left untouched rather than dropped.
struct EntityFilterSheet: View {
    let descriptor: EntityDescriptor
    let onApply: (EntityFilterState) async -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var draft: EntityFilterDraft
    @State private var picking: FilterDescriptor?
    @State private var pendingTokens: [String: String] = [:]
    private let initial: EntityFilterState

    init(
        descriptor: EntityDescriptor, filters: EntityFilterState,
        onApply: @escaping (EntityFilterState) async -> Void
    ) {
        self.descriptor = descriptor
        self.onApply = onApply
        self.initial = filters
        // Presented via `.sheet(isPresented:)` at a fixed call site (`EntityListView`) —
        // dismissing tears the subtree down, so re-presenting rebuilds this seed fresh.
        _draft = State(initialValue: EntityFilterDraft(filters))  // state-init-ok
    }

    var body: some View {
        NavigationStack {
            Form {
                ForEach(descriptor.filters, id: \.columnId) { filter in
                    Section {
                        control(for: filter)
                    } header: {
                        HStack {
                            Text(EntityFilterDraft.label(for: filter, in: descriptor))
                            Spacer()
                            if draft.isActive(filter) {
                                Button("Clear") { draft.clear(filter) }
                                    .font(.caption)
                                    .buttonStyle(.borderless)
                            }
                        }
                    }
                }
            }
            .formStyle(.grouped)
            .navigationTitle("Filter \(descriptor.plural)")
            #if os(iOS)
                .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .destructiveAction) {
                    Button("Reset") { draft = EntityFilterDraft() }
                        .disabled(draft.state.isEmpty)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Apply") {
                        let state = draft.state
                        Task { await onApply(state) }
                        dismiss()
                    }
                    .disabled(draft.state == initial)
                }
            }
            .sheet(item: $picking) { filter in
                if let target = filter.targetEntity {
                    EntityPickerSheet(
                        target: target,
                        multiple: filter.kind == .idMulti,
                        selected: filter.kind == .idMulti
                            ? draft.many(filter) : [draft.single(filter)].filter { !$0.isEmpty }
                    ) { picks in
                        if filter.kind == .idMulti {
                            draft.setMany(picks.map(\.id), for: filter)
                        } else {
                            draft.setSingle(picks.first?.id ?? "", for: filter)
                        }
                    }
                }
            }
        }
        .nativeSheet(.editor)
    }

    @ViewBuilder
    private func control(for filter: FilterDescriptor) -> some View {
        switch filter.kind {
        case .text:
            TextField(
                filter.placeholder,
                text: Binding(get: { draft.single(filter) }, set: { draft.setSingle($0, for: filter) })
            )
            .textFieldStyle(.plain)
        case .select:
            Picker(
                EntityFilterDraft.label(for: filter, in: descriptor),
                selection: Binding(get: { draft.single(filter) }, set: { draft.setSingle($0, for: filter) })
            ) {
                Text("Any").tag("")
                ForEach(EntityFilterDraft.options(for: filter, in: descriptor)) { option in
                    Text(option.label).tag(option.value)
                }
            }
            .labelsHidden()
        case .multiselect:
            let selected = Set(draft.many(filter))
            let options = EntityFilterDraft.options(for: filter, in: descriptor)
            // The server supplies these choices to the web filter bar (distinct column values);
            // native has no such read, so an option-less multiselect takes typed values.
            if options.isEmpty {
                ForEach(draft.many(filter), id: \.self) { value in
                    HStack {
                        Text(value)
                        Spacer()
                        Button("Remove", systemImage: "xmark.circle.fill") {
                            draft.setMany(draft.many(filter).filter { $0 != value }, for: filter)
                        }
                        .labelStyle(.iconOnly)
                        .foregroundStyle(.secondary)
                        .buttonStyle(.borderless)
                        .accessibilityLabel("Remove \(value)")
                    }
                    .frame(minHeight: PorcelainTokens.touchTarget)
                }
                TextField(
                    filter.placeholder,
                    text: Binding(
                        get: { pendingTokens[filter.columnId] ?? "" },
                        set: { pendingTokens[filter.columnId] = $0 })
                )
                .onSubmit {
                    let value = (pendingTokens[filter.columnId] ?? "").trimmingCharacters(in: .whitespaces)
                    guard !value.isEmpty, !selected.contains(value) else { return }
                    draft.setMany(draft.many(filter) + [value], for: filter)
                    pendingTokens[filter.columnId] = nil
                }
            }
            ForEach(options) { option in
                Button {
                    var values = draft.many(filter)
                    if let index = values.firstIndex(of: option.value) {
                        values.remove(at: index)
                    } else {
                        values.append(option.value)
                    }
                    draft.setMany(values, for: filter)
                } label: {
                    HStack {
                        Text(option.label).foregroundStyle(PorcelainTokens.graphite)
                        Spacer()
                        if selected.contains(option.value) {
                            Image(systemName: "checkmark").foregroundStyle(PorcelainTokens.cobalt)
                        }
                    }
                    .frame(minHeight: PorcelainTokens.touchTarget)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(selected.contains(option.value) ? .isSelected : [])
            }
        case .presence:
            threeState(filter, on: ("has", "Has"), off: ("none", "None"))
        case .boolean:
            threeState(filter, on: ("true", "Yes"), off: ("false", "No"))
        case .id, .idMulti:
            let ids =
                filter.kind == .idMulti ? draft.many(filter) : [draft.single(filter)].filter { !$0.isEmpty }
            Button {
                picking = filter
            } label: {
                LabeledContent(filter.kind == .idMulti ? "Choose…" : "Choose one…") {
                    Text(ids.isEmpty ? "Any" : ids.joined(separator: ", "))
                        .font(ids.isEmpty ? .porcelainBody : .porcelainCode)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
                .frame(minHeight: PorcelainTokens.touchTarget)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(filter.targetEntity == nil)
        case .range:
            // A `range` bound to one parameter (product `price`) is its presence arm alone.
            if case .param = filter.wire {
                Picker(
                    EntityFilterDraft.label(for: filter, in: descriptor),
                    selection: Binding(
                        get: { draft.single(filter) }, set: { draft.setSingle($0, for: filter) })
                ) {
                    Text("Any").tag("")
                    ForEach(EntityFilterDraft.options(for: filter, in: descriptor)) { option in
                        Text(option.label).tag(option.value)
                    }
                }
                .labelsHidden()
            } else {
                rangeControl(filter)
            }
        }
    }

    private func threeState(_ filter: FilterDescriptor, on: (String, String), off: (String, String))
        -> some View
    {
        Picker(
            EntityFilterDraft.label(for: filter, in: descriptor),
            selection: Binding(get: { draft.single(filter) }, set: { draft.setSingle($0, for: filter) })
        ) {
            Text("Any").tag("")
            Text(on.1).tag(on.0)
            Text(off.1).tag(off.0)
        }
        .pickerStyle(.segmented)
        .labelsHidden()
    }

    @ViewBuilder
    private func rangeControl(_ filter: FilterDescriptor) -> some View {
        let range = draft.range(filter)
        let hasPresence: Bool = {
            if case .range(_, _, let presence) = filter.wire { return presence != nil }
            return false
        }()
        if hasPresence {
            Picker(
                "Presence",
                selection: Binding(
                    get: { range.presence },
                    set: { value in
                        var revised = draft.range(filter)
                        revised.presence = value
                        draft.setRange(revised, for: filter)
                    })
            ) {
                Text("Any").tag("")
                Text("Has").tag("has")
                Text("None").tag("none")
            }
            .pickerStyle(.segmented)
        }
        if EntityFilterDraft.rangeIsDates(filter, in: descriptor) {
            dateBound("From", value: range.from) { value in
                var revised = draft.range(filter)
                revised.from = value
                draft.setRange(revised, for: filter)
            }
            dateBound("To", value: range.to) { value in
                var revised = draft.range(filter)
                revised.to = value
                draft.setRange(revised, for: filter)
            }
        } else {
            LabeledContent("Min") {
                TextField(
                    "Any",
                    text: Binding(
                        get: { range.from },
                        set: { value in
                            var revised = draft.range(filter)
                            revised.from = value
                            draft.setRange(revised, for: filter)
                        })
                )
                .multilineTextAlignment(.trailing)
                #if os(iOS)
                    .keyboardType(.decimalPad)
                #endif
            }
            LabeledContent("Max") {
                TextField(
                    "Any",
                    text: Binding(
                        get: { range.to },
                        set: { value in
                            var revised = draft.range(filter)
                            revised.to = value
                            draft.setRange(revised, for: filter)
                        })
                )
                .multilineTextAlignment(.trailing)
                #if os(iOS)
                    .keyboardType(.decimalPad)
                #endif
            }
        }
    }

    /// A date bound is optional: a toggle turns the picker on with today, off clears the parameter.
    @ViewBuilder
    private func dateBound(_ label: String, value: String, set: @escaping (String) -> Void) -> some View {
        Toggle(
            label, isOn: Binding(get: { !value.isEmpty }, set: { set($0 ? PlainDate(.now).rawValue : "") }))
        if !value.isEmpty {
            DatePicker(
                label,
                selection: Binding(
                    get: { PlainDate(rawValue: value).date ?? .now },
                    set: { set(PlainDate($0).rawValue) }),
                displayedComponents: .date
            )
            .labelsHidden()
        }
    }
}

#Preview("Product filters") {
    EntityFilterSheet(descriptor: EntityCatalog[.product], filters: EntityFilterState()) { _ in }
        .environment(PreviewFixtures.signedInModel())
}
