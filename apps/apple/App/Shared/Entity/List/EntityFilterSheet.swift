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

    /// A filter that accepts it (`currentMember`) takes this literal alongside shortcodes; the
    /// server resolves it to the signed-in member (docs/adr/0018-current-member-filter-token.md).
    static let currentMemberToken = "@me"

    /// The named states an id filter accepts beside record codes, sent unbranded: "Me" when the
    /// filter declares `currentMember`, then the declaration's own `sentinels` (an Owner
    /// filter's Household).
    static func tokens(_ filter: FilterDescriptor) -> [LabeledOption] {
        (filter.currentMember ? [LabeledOption(value: currentMemberToken, label: "Me")] : [])
            + (filter.sentinels ?? [])
    }

    /// The picked ids as shown to a person: a token reads as its label ("Me"), never `@me`.
    static func displayName(forFilterValue value: String, in filter: FilterDescriptor) -> String {
        tokens(filter).first { $0.value == value }?.label ?? value
    }

    /// The filters the sheet renders as sections. A reference filter's generated subtree toggle
    /// and a value filter's presence parameter render inside that filter's own section, so their
    /// standalone descriptors would write the same parameter twice.
    static func sections(of descriptor: EntityDescriptor) -> [FilterDescriptor] {
        let embedded = Set(
            descriptor.filters.flatMap { [$0.subtreeParam, $0.presenceParam].compactMap(\.self) })
        return descriptor.filters.filter { filter in
            guard case .param(let name) = filter.wire else { return true }
            return !embedded.contains(name)
        }
    }

    /// `text`, `boolean`, `presence`, and a one-parameter `range`: the one string under the
    /// parameter, empty when unset.
    func value(_ filter: FilterDescriptor) -> String {
        values(filter).first ?? ""
    }

    mutating func setValue(_ value: String, for filter: FilterDescriptor) {
        guard case .param(let name) = filter.wire else { return }
        state.set([value], for: name)
    }

    /// The two sides of a value filter: "is" picks the values rows match (the filter's wire
    /// parameter), "is not" the values they must not match (`excludeParam`). Both can hold values.
    enum Side: Hashable {
        case include
        case exclude
    }

    /// The parameter a side writes; nil for "is not" on a filter without an exclude key.
    static func parameter(_ filter: FilterDescriptor, side: Side) -> String? {
        switch side {
        case .include:
            guard case .param(let name) = filter.wire else { return nil }
            return name
        case .exclude:
            return filter.excludeParam
        }
    }

    /// `multiselect`, `idMulti`: the picked values (any-of) on one side.
    func values(_ filter: FilterDescriptor, side: Side = .include) -> [String] {
        Self.parameter(filter, side: side).flatMap { state[$0] } ?? []
    }

    /// Picking a specific value clears Any value, which already includes it; No value stays.
    /// A value lives on one side only, so picking it removes it from the other.
    mutating func setValues(_ values: [String], for filter: FilterDescriptor, side: Side = .include) {
        guard let name = Self.parameter(filter, side: side) else { return }
        state.set(values, for: name)
        let other: Side = side == .include ? .exclude : .include
        if let otherName = Self.parameter(filter, side: other), let current = state[otherName] {
            state.set(current.filter { !values.contains($0) }, for: otherName)
        }
        if side == .include, !values.isEmpty, presence(filter) == Self.anyValue,
            let param = filter.presenceParam
        {
            state.remove(param)
        }
    }

    func selects(_ value: String, in filter: FilterDescriptor, side: Side = .include) -> Bool {
        values(filter, side: side).contains(value)
    }

    /// Adds or removes one value; the other picks stay.
    mutating func set(_ value: String, _ on: Bool, for filter: FilterDescriptor, side: Side = .include) {
        let rest = values(filter, side: side).filter { $0 != value }
        setValues(on ? [value] + rest : rest, for: filter, side: side)
    }

    /// The "is not" side as one line: "Category is not Outerwear or Socks"; nil when none.
    static func excludedSummary(
        _ filter: FilterDescriptor, in descriptor: EntityDescriptor, state: EntityFilterState
    ) -> String? {
        guard let name = filter.excludeParam, let excluded = state[name], !excluded.isEmpty else {
            return nil
        }
        let labels = Dictionary(
            options(for: filter, in: descriptor).map { ($0.value, $0.label) },
            uniquingKeysWith: { first, _ in first })
        let values = excluded.map { labels[$0] ?? displayName(forFilterValue: $0, in: filter) }
        return "\(label(for: filter, in: descriptor)) is not \(values.joined(separator: " or "))"
    }

    /// Clears the "is not" side alone.
    mutating func clearExcluded(_ filter: FilterDescriptor) {
        if let name = filter.excludeParam { state.remove(name) }
    }

    /// The presence parameter's values: Any value (`has`) and No value (`none`).
    static let anyValue = "has"
    static let noValue = "none"

    /// `has`, `none`, or nil when the filter has no presence parameter or it is unset.
    func presence(_ filter: FilterDescriptor) -> String? {
        filter.presenceParam.flatMap { state[$0]?.first }
    }

    /// Any value includes every specific value, so turning it on clears them and No value.
    mutating func setAnyValue(_ on: Bool, for filter: FilterDescriptor) {
        guard let param = filter.presenceParam else { return }
        if on {
            if case .param(let name) = filter.wire { state.remove(name) }
            state.set([Self.anyValue], for: param)
        } else if presence(filter) == Self.anyValue {
            state.remove(param)
        }
    }

    /// No value combines with specific values ("A or no value") and replaces Any value.
    mutating func setNoValue(_ on: Bool, for filter: FilterDescriptor) {
        guard let param = filter.presenceParam else { return }
        if on {
            state.set([Self.noValue], for: param)
        } else if presence(filter) == Self.noValue {
            state.remove(param)
        }
    }

    /// Match all (`matchParam=all`) on a multi-valued field; absent means Match any.
    func matchesAll(_ filter: FilterDescriptor) -> Bool {
        filter.matchParam.flatMap { state[$0]?.first } == "all"
    }

    mutating func setMatchesAll(_ on: Bool, for filter: FilterDescriptor) {
        guard let param = filter.matchParam else { return }
        state.set(on ? ["all"] : [], for: param)
    }

    /// Include sub-‹entity› on a hierarchical reference: on by default, so only "false" is sent.
    func includesSubtree(_ filter: FilterDescriptor) -> Bool {
        filter.subtreeParam.flatMap { state[$0]?.first } != "false"
    }

    mutating func setIncludesSubtree(_ on: Bool, for filter: FilterDescriptor) {
        guard let param = filter.subtreeParam else { return }
        state.set(on ? [] : ["false"], for: param)
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
            from: state[from]?.first ?? "",
            to: state[to]?.first ?? "",
            presence: presence.flatMap { state[$0]?.first } ?? "")
    }

    mutating func setRange(_ range: Range, for filter: FilterDescriptor) {
        guard case .range(let from, let to, let presence) = filter.wire else { return }
        state.set([range.from], for: from)
        state.set([range.to], for: to)
        if let presence { state.set([range.presence], for: presence) }
    }

    /// Every parameter the filter's section writes: its wire names plus presence, match, exclude,
    /// and subtree parameters.
    private static func parameters(_ filter: FilterDescriptor) -> [String] {
        filter.wire.names
            + [filter.presenceParam, filter.matchParam, filter.excludeParam, filter.subtreeParam].compactMap(
                \.self)
    }

    /// Whether any of the filter's parameters carry a value.
    func isActive(_ filter: FilterDescriptor) -> Bool {
        Self.parameters(filter).contains { state[$0] != nil }
    }

    mutating func clear(_ filter: FilterDescriptor) {
        for name in Self.parameters(filter) { state.remove(name) }
    }

    /// A `range` filter edits dates when its column is a date/timestamp field, else numbers.
    static func rangeIsDates(_ filter: FilterDescriptor, in descriptor: EntityDescriptor) -> Bool {
        guard let field = descriptor.field(filter.columnId) else {
            return filter.columnId.hasSuffix("At") || filter.columnId.hasSuffix("Date")
                || filter.columnId.hasSuffix("On")
        }
        return field.kind == .date || field.kind == .timestamp
    }

    /// The choices a `multiselect` offers: declared `options`, else the list route's
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

/// Every declared filter of one entity as a form, applied in one go. Each `EntityFilterKind`
/// maps to a native control; a filter the sheet cannot edit (an id picker whose target has no
/// descriptor) is left untouched rather than dropped.
struct EntityFilterSheet: View {
    let descriptor: EntityDescriptor
    let onApply: (EntityFilterState) async -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var draft: EntityFilterDraft
    @State private var picking: FilterDescriptor?
    /// The side the open record picker writes.
    @State private var pickingSide: EntityFilterDraft.Side = .include
    /// Filters whose editor shows the "is not" side (by `columnId`); every editor opens on "is".
    @State private var excluding: Set<String> = []
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
                ForEach(EntityFilterDraft.sections(of: descriptor), id: \.columnId) { filter in
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
                    // A declared `singleValue` scope filter takes one record.
                    EntityPickerSheet(
                        target: target, multiple: filter.singleValue != true,
                        selected: pickedIDs(filter, side: pickingSide)
                    ) { picks in
                        // The picker never sees a token ("Me", Household), so keep them across a pick.
                        let kept = EntityFilterDraft.tokens(filter).map(\.value).filter {
                            draft.selects($0, in: filter, side: pickingSide)
                        }
                        draft.setValues(kept + picks.map(\.id), for: filter, side: pickingSide)
                    }
                }
            }
        }
        .nativeSheet(.editor)
    }

    /// The ids the picker preselects: real records only, never a token.
    private func pickedIDs(_ filter: FilterDescriptor, side: EntityFilterDraft.Side) -> [String] {
        let tokens = Set(EntityFilterDraft.tokens(filter).map(\.value))
        return draft.values(filter, side: side).filter { !tokens.contains($0) }
    }

    private func side(_ filter: FilterDescriptor) -> EntityFilterDraft.Side {
        excluding.contains(filter.columnId) && filter.excludeParam != nil ? .exclude : .include
    }

    private func valueBinding(_ filter: FilterDescriptor) -> Binding<String> {
        Binding(get: { draft.value(filter) }, set: { draft.setValue($0, for: filter) })
    }

    @ViewBuilder
    private func control(for filter: FilterDescriptor) -> some View {
        switch filter.kind {
        case .text:
            TextField(filter.placeholder, text: valueBinding(filter))
                .textFieldStyle(.plain)
        case .multiselect:
            sideToggle(filter)
            if side(filter) == .include { valueModes(filter) }
            multiselectValues(filter, side: side(filter))
            subtreeToggle(filter)
            excludedSummary(filter)
        case .idMulti:
            sideToggle(filter)
            if side(filter) == .include { valueModes(filter) }
            idValues(filter, side: side(filter))
            subtreeToggle(filter)
            excludedSummary(filter)
        case .presence:
            threeState(filter, on: ("has", "Has"), off: ("none", "None"))
        case .boolean:
            threeState(filter, on: ("true", "Yes"), off: ("false", "No"))
        case .range:
            // A `range` bound to one parameter (product `price`) is its presence arm alone.
            if case .param = filter.wire {
                Picker(EntityFilterDraft.label(for: filter, in: descriptor), selection: valueBinding(filter))
                {
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

    /// is | is not above a filter that declares an exclude key. Any value, No value, and Match all
    /// belong to "is"; Include sub-… is shared.
    @ViewBuilder
    private func sideToggle(_ filter: FilterDescriptor) -> some View {
        if filter.excludeParam != nil {
            Picker(
                "Condition",
                selection: Binding(
                    get: { side(filter) },
                    set: { side in
                        if side == .exclude {
                            excluding.insert(filter.columnId)
                        } else {
                            excluding.remove(filter.columnId)
                        }
                    })
            ) {
                Text("is").tag(EntityFilterDraft.Side.include)
                Text("is not").tag(EntityFilterDraft.Side.exclude)
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .accessibilityIdentifier("filter.\(filter.columnId).side")
        }
    }

    /// The "is not" side's summary while "is" is showing; removing it clears only the exclusions.
    @ViewBuilder
    private func excludedSummary(_ filter: FilterDescriptor) -> some View {
        if side(filter) == .include,
            let summary = EntityFilterDraft.excludedSummary(filter, in: descriptor, state: draft.state)
        {
            HStack {
                Text(summary).foregroundStyle(.secondary)
                Spacer()
                Button("Remove", systemImage: "xmark.circle.fill") { draft.clearExcluded(filter) }
                    .labelStyle(.iconOnly)
                    .foregroundStyle(.secondary)
                    .buttonStyle(.borderless)
                    .accessibilityLabel("Remove \(summary)")
            }
            .frame(minHeight: FieldGuideTokens.touchTarget)
            .accessibilityIdentifier("filter.\(filter.columnId).excluded")
        }
    }

    /// The rows above a value filter's values: Match any | Match all on a multi-valued field,
    /// then Any value and No value on a nullable one. The grouped form's row separator below them
    /// is the divider from the values.
    @ViewBuilder
    private func valueModes(_ filter: FilterDescriptor) -> some View {
        if filter.matchParam != nil {
            Picker(
                "Match",
                selection: Binding(
                    get: { draft.matchesAll(filter) }, set: { draft.setMatchesAll($0, for: filter) })
            ) {
                Text("Match any").tag(false)
                Text("Match all").tag(true)
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .accessibilityIdentifier("filter.\(filter.columnId).matchAll")
        }
        if filter.presenceParam != nil {
            checkRow(
                "Any value", selected: draft.presence(filter) == EntityFilterDraft.anyValue,
                identifier: "filter.\(filter.columnId).any"
            ) { draft.setAnyValue($0, for: filter) }
            checkRow(
                "No value", selected: draft.presence(filter) == EntityFilterDraft.noValue,
                identifier: "filter.\(filter.columnId).none"
            ) { draft.setNoValue($0, for: filter) }
        }
    }

    @ViewBuilder
    private func multiselectValues(_ filter: FilterDescriptor, side: EntityFilterDraft.Side) -> some View {
        let selected = Set(draft.values(filter, side: side))
        let pendingKey = "\(filter.columnId).\(side)"
        let options = EntityFilterDraft.options(for: filter, in: descriptor)
        // The server supplies these choices to the web filter bar (distinct column values);
        // native has no such read, so an option-less multiselect takes typed values.
        if options.isEmpty {
            ForEach(draft.values(filter, side: side), id: \.self) { value in
                HStack {
                    Text(value)
                    Spacer()
                    Button("Remove", systemImage: "xmark.circle.fill") {
                        draft.set(value, false, for: filter, side: side)
                    }
                    .labelStyle(.iconOnly)
                    .foregroundStyle(.secondary)
                    .buttonStyle(.borderless)
                    .accessibilityLabel("Remove \(value)")
                }
                .frame(minHeight: FieldGuideTokens.touchTarget)
            }
            TextField(
                filter.placeholder,
                text: Binding(
                    get: { pendingTokens[pendingKey] ?? "" },
                    set: { pendingTokens[pendingKey] = $0 })
            )
            .onSubmit {
                let value = (pendingTokens[pendingKey] ?? "").trimmingCharacters(in: .whitespaces)
                guard !value.isEmpty, !selected.contains(value) else { return }
                draft.setValues(draft.values(filter, side: side) + [value], for: filter, side: side)
                pendingTokens[pendingKey] = nil
            }
        }
        ForEach(options) { option in
            checkRow(
                option.label, selected: selected.contains(option.value),
                identifier: "filter.\(filter.columnId).value.\(option.value)"
            ) {
                draft.set(option.value, $0, for: filter, side: side)
            }
        }
    }

    @ViewBuilder
    private func idValues(_ filter: FilterDescriptor, side: EntityFilterDraft.Side) -> some View {
        let ids = pickedIDs(filter, side: side)
        ForEach(EntityFilterDraft.tokens(filter), id: \.value) { token in
            Toggle(
                token.label,
                isOn: Binding(
                    get: { draft.selects(token.value, in: filter, side: side) },
                    set: { draft.set(token.value, $0, for: filter, side: side) })
            )
            .frame(minHeight: FieldGuideTokens.touchTarget)
            // `@me` → `filter.<column>.me`, `@household` → `filter.<column>.household`.
            .accessibilityIdentifier("filter.\(filter.columnId).\(token.value.trimmingPrefix("@"))")
        }
        Button {
            pickingSide = side
            picking = filter
        } label: {
            LabeledContent("Choose…") {
                Text(ids.isEmpty ? (side == .include ? "Any" : "None") : ids.joined(separator: ", "))
                    .font(ids.isEmpty ? .fieldGuideBody : .fieldGuideCode)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            .frame(minHeight: FieldGuideTokens.touchTarget)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(filter.targetEntity == nil)
    }

    /// Include sub-‹entity›: the toggle's own descriptor supplies its label.
    @ViewBuilder
    private func subtreeToggle(_ filter: FilterDescriptor) -> some View {
        if let param = filter.subtreeParam {
            let own = descriptor.filters.first { $0.wire.names == [param] }
            let target = filter.targetEntity.map { EntityCatalog[$0].plural.lowercased() } ?? "records"
            let label = own?.label ?? "Include sub-\(target)"
            Toggle(
                label,
                isOn: Binding(
                    get: { draft.includesSubtree(filter) }, set: { draft.setIncludesSubtree($0, for: filter) }
                )
            )
            .frame(minHeight: FieldGuideTokens.touchTarget)
            .accessibilityIdentifier("filter.\(filter.columnId).subtree")
        }
    }

    private func checkRow(
        _ label: String, selected: Bool, identifier: String, toggle: @escaping (Bool) -> Void
    ) -> some View {
        Button {
            toggle(!selected)
        } label: {
            HStack {
                Text(label).foregroundStyle(FieldGuideTokens.graphite)
                Spacer()
                if selected {
                    Image(systemName: "checkmark").foregroundStyle(FieldGuideTokens.interaction)
                }
            }
            .frame(minHeight: FieldGuideTokens.touchTarget)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
        .accessibilityIdentifier(identifier)
    }

    private func threeState(_ filter: FilterDescriptor, on: (String, String), off: (String, String))
        -> some View
    {
        Picker(EntityFilterDraft.label(for: filter, in: descriptor), selection: valueBinding(filter)) {
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

    /// How a date bound is set: not at all, a calendar day, or a day relative to today.
    private enum DateBoundMode: Hashable { case any, date, relative }

    /// A date bound is optional. A relative bound keeps its token (`@today-30d`), which the
    /// server resolves against the household's today, so an edited or saved filter stays
    /// current instead of freezing into the day it was set.
    @ViewBuilder
    private func dateBound(_ label: String, value: String, set: @escaping (String) -> Void) -> some View {
        let days = RelativeDate.offset(value)
        let mode: DateBoundMode = value.isEmpty ? .any : days == nil ? .date : .relative
        Picker(
            label,
            selection: Binding(
                get: { mode },
                set: { next in
                    switch next {
                    case .any: set("")
                    case .date: set(PlainDate(.now).rawValue)
                    case .relative: set(RelativeDate.token(0))
                    }
                })
        ) {
            Text("Any").tag(DateBoundMode.any)
            Text("Date").tag(DateBoundMode.date)
            Text("Relative").tag(DateBoundMode.relative)
        }
        .pickerStyle(.segmented)
        switch mode {
        case .any:
            EmptyView()
        case .date:
            DatePicker(
                label,
                selection: Binding(
                    get: { PlainDate(rawValue: value).date() ?? .now },
                    set: { set(PlainDate($0).rawValue) }),
                displayedComponents: .date
            )
            .labelsHidden()
        case .relative:
            relativeBound(label, value: value, set: set)
        }
    }

    /// N days ago or ahead of the household's today, shown as "today − 30 days". The direction
    /// reads from the token itself (`@today+0d` is ahead at zero), so it survives a zero count.
    private func relativeBound(_ label: String, value: String, set: @escaping (String) -> Void)
        -> some View
    {
        let days = RelativeDate.offset(value) ?? 0
        let ahead = value.hasPrefix(RelativeDate.today + "+")
        return LabeledContent(RelativeDate.describe(days)) {
            HStack {
                TextField(
                    "Days",
                    value: Binding(
                        get: { abs(days) },
                        set: { set(RelativeDate.token(max($0, 0), ahead: ahead)) }),
                    format: .number
                )
                .multilineTextAlignment(.trailing)
                .frame(maxWidth: 64)
                #if os(iOS)
                    .keyboardType(.numberPad)
                #endif
                Picker(
                    "\(label) direction",
                    selection: Binding(
                        get: { ahead },
                        set: { set(RelativeDate.token(abs(days), ahead: $0)) })
                ) {
                    Text("ago").tag(false)
                    Text("ahead").tag(true)
                }
                .labelsHidden()
                .fixedSize()
            }
        }
    }
}

#Preview("Product filters") {
    EntityFilterSheet(descriptor: EntityCatalog[.product], filters: EntityFilterState()) { _ in }
        .environment(PreviewFixtures.signedInModel())
}

#Preview("Relative recount filter") {
    EntityFilterSheet(
        descriptor: EntityCatalog[.location],
        filters: EntityFilterState([
            "lastBulkInventoryTo": ["@today-30d"], "lastBulkInventoryPresenceFilter": ["none"],
        ])
    ) { _ in }
    .environment(PreviewFixtures.signedInModel())
}
