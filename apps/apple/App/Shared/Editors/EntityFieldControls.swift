import CubbyKit
import SwiftUI

#if os(macOS)
    import AppKit
#endif

/// One editor control for one catalog field, chosen by `controlKind` × `kind`. Errors from the last save render as the row's footer.
struct EntityFieldControl: View {
    let field: FieldDescriptor
    @Bindable var model: GenericEntityEditModel
    /// Titles of picked references, so a row shows a name rather than a shortcode.
    @Binding var pickedTitles: [String: String]
    @State private var picking = false
    @State private var newToken = ""
    @State private var newCollection = ""

    private var key: String { field.key }
    private var value: JSONValue { model.draft[key] ?? .null }
    private var pickerScope: EntityPickerScope? {
        EntityReferenceScope.pickerScope(field: field, draft: model.draft)
    }

    /// A structured value draws one Form row per input (see `StructuredValueControl`), so its
    /// footer follows as sibling rows rather than wrapping the field in one tall cell.
    @ViewBuilder
    var body: some View {
        if field.controlKind == .specialized, field.valueSchema != nil {
            control
            footer
        } else {
            VStack(alignment: .leading, spacing: FieldGuideTokens.Space.xs) {
                control
                footer
            }
        }
    }

    @ViewBuilder
    private var footer: some View {
        if let resolved = model.resolutionForEditor(field) {
            resolutionLine(resolved)
        } else if let original = model.original,
            let saved = FieldResolutionPresentation(raw: original, field: field)
        {
            resolutionLine(saved, stale: true)
        } else if model.isCreate, let policy = field.resolution, policy.none != nil {
            // A new record inherits by default; an explicit None must stay reachable before save.
            HStack {
                Spacer()
                resolutionMenu {
                    Button(noneLabel(policy)) { model.stageResolutionNone(key) }
                        .accessibilityIdentifier("editor.\(model.descriptor.key.rawValue).\(key).none")
                }
            }
        }
        if let error = model.fieldErrors[key] {
            Text(error)
                .font(.caption)
                .foregroundStyle(FieldGuideTokens.destructive)
                .accessibilityLabel("\(field.label) error: \(error)")
        }
    }

    // MARK: - Resolution

    /// One secondary line under the control: the state marker, the effective value and where it
    /// comes from, and a menu holding only the links that would change the field. A staged link
    /// is an ordinary draft edit, so Save needs no separate notice.
    ///
    /// `stale`: the draft differs from the saved record, so the server's effective value may no
    /// longer hold (a reparent changes the source). Reset and Set to none stay offered from the
    /// saved policy, staged as their plain patches; Confirm is withheld because it pins the saved
    /// effective value.
    @ViewBuilder
    private func resolutionLine(_ resolved: FieldResolutionPresentation, stale: Bool = false) -> some View {
        let state = resolved.state(field: field)
        let offered = resolved.actions(field: field).filter { !stale || $0.kind != .confirm }
        let staged =
            stale
            ? offered.first { action in
                action.payload.allSatisfy { (model.draft[$0.key] ?? .null) == $0.value }
            }
            : nil
        let actions = offered.filter { $0 != staged }
        let caption =
            stale
            ? staged.map { "\($0.label) on save" } ?? "Inheritance updates when saved"
            : resolutionCaption(resolved, hasActions: !actions.isEmpty)
        if let caption {
            HStack(spacing: FieldGuideTokens.Space.xs) {
                Image(systemName: state.systemImage).imageScale(.small).accessibilityHidden(true)
                Text(caption).fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: FieldGuideTokens.Space.sm)
                if !actions.isEmpty {
                    resolutionMenu {
                        ForEach(actions) { action in
                            Button(actionLabel(action, resolved: resolved)) {
                                if stale {
                                    model.stage(action.payload)
                                } else {
                                    model.stageResolution(action.kind, for: key)
                                }
                            }
                            .accessibilityIdentifier(
                                "editor.\(model.descriptor.key.rawValue).\(key).\(action.kind == .useInherited ? "reset" : action.kind == .setNone ? "none" : action.kind.rawValue)"
                            )
                        }
                    }
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
    }

    /// The control shows the stored value, so an inherited value is named here with its source.
    /// A plain Set here value with nothing to change needs no caption.
    private func resolutionCaption(_ resolved: FieldResolutionPresentation, hasActions: Bool) -> String? {
        switch resolved.resolution.mode {
        case .inherit:
            guard let value = valueText(resolved.effectiveValue) else {
                return hasActions ? "Nothing to inherit" : nil
            }
            return "\(value), inherited from \(resolved.sourceEntity?.name ?? resolved.resolution.source)"
        case .allocated:
            return resolved.sourceText
        case .none:
            return resolved.emptyLabel(field: field)
        case .explicit:
            let state = resolved.state(field: field)
            return state.tone == .set && !hasActions ? nil : state.label
        }
    }

    /// Use inherited names the value it brings back, so the menu says what Save will apply.
    private func actionLabel(_ action: FieldResolutionAction, resolved: FieldResolutionPresentation) -> String
    {
        guard action.kind == .useInherited, let fallback = valueText(resolved.fallbackValue) else {
            return action.label
        }
        return "\(action.label) (\(fallback))"
    }

    private func valueText(_ value: JSONValue) -> String? {
        if field.reference != nil, let id = value.stringValue {
            return model.original.flatMap {
                FieldResolutionPresentation.referenceName(in: $0, field: field, effectiveID: id)
            } ?? pickedTitles[id] ?? id
        }
        return EntityFieldValue.text(value, field: field)
    }

    private func noneLabel(_ policy: FieldResolutionDescriptor) -> String {
        "Set to \(policy.labels?.none ?? "none")"
    }

    private func resolutionMenu(@ViewBuilder content: () -> some View) -> some View {
        Menu(content: content) {
            Image(systemName: "ellipsis.circle")
                .imageScale(.large)
                .frame(minWidth: FieldGuideTokens.touchTarget, minHeight: FieldGuideTokens.touchTarget)
                .contentShape(Rectangle())
        }
        .menuIndicator(.hidden)
        .buttonStyle(.borderless)
        .accessibilityLabel("\(field.label) inheritance")
    }

    private var label: String {
        model.isRequired(field) ? "\(field.label) *" : field.label
    }

    /// A select's choices: the declared `controlOptions`, else the same-named list filter's
    /// (declared, or the route's enum), else at least the current value so it is not blank.
    private var selectOptions: [(value: String, label: String)] {
        if let options = field.controlOptions { return options.map { ($0.value, $0.label) } }
        let descriptor = model.descriptor
        if let filter = descriptor.filters.first(where: { $0.columnId == key }) {
            if let options = filter.options { return options.map { ($0.value, $0.label) } }
            if case .param(let name) = filter.wire, let values = descriptor.filterValues(for: name) {
                return values.map { ($0, EntityFieldValue.enumLabel($0, field: field)) }
            }
        }
        guard let current = value.stringValue, !current.isEmpty else { return [] }
        return [(current, EntityFieldValue.enumLabel(current, field: field))]
    }

    @ViewBuilder
    private var control: some View {
        switch field.controlKind {
        case .text:
            if key == model.descriptor.recordEmojiField {
                emojiControl
            } else {
                LabeledContent(label) {
                    TextField(label, text: stringBinding, prompt: Text(field.placeholder ?? "None"))
                        .multilineTextAlignment(.trailing)
                        .labelsHidden()
                }
            }
        case .textarea:
            VStack(alignment: .leading, spacing: FieldGuideTokens.Space.xs) {
                Text(label).font(.fieldGuideLabel).foregroundStyle(.secondary)
                TextField(
                    label, text: stringBinding, prompt: Text(field.placeholder ?? "None"), axis: .vertical
                )
                .lineLimit(3...8)
                .labelsHidden()
            }
        case .checkbox:
            Toggle(
                label, isOn: Binding(get: { value.boolValue ?? false }, set: { model.draft[key] = .bool($0) })
            )
        case .select:
            Picker(label, selection: stringBinding) {
                // A non-nullable enum can only be unset before the record exists.
                if field.nullable || (model.isCreate && value == .null) { Text("None").tag("") }
                ForEach(selectOptions, id: \.value) { option in
                    Text(option.label).tag(option.value)
                }
            }
        case .date:
            dateControl
        case .number:
            LabeledContent(label) {
                TextField(
                    label,
                    value: Binding(
                        get: { value.doubleValue },
                        set: { model.draft[key] = $0.map(JSONValue.number) ?? .null }),
                    format: .number,
                    prompt: Text(field.placeholder ?? "0")
                )
                .multilineTextAlignment(.trailing)
                .labelsHidden()
                .accessibilityIdentifier("editor.\(model.descriptor.key.rawValue).\(key)")
                #if os(iOS)
                    .keyboardType(.decimalPad)
                #endif
            }
        case .specialized:
            specialized
        case nil:
            EmptyView()
        }
    }

    // MARK: - Specialized

    /// The native control a specialized renderer draws. Each renderer `native-coverage.ts` marks
    /// `implemented` draws one and each `generic` one may; any other renderer (one only web draws,
    /// such as the image block's `.imageOrder`) draws nothing. The generated per-status enums make
    /// the compiler hold these switches to the declarations. A field with a declared `valueSchema`
    /// (the structured renderers) is drawn by `StructuredValueControl` whatever its renderer.
    enum Drawing {
        case entityReference, entityMultiReference, amount, tokens, productTags, text, money,
            ledgerAttributions
    }

    static func drawing(for renderer: ControlRendererID) -> Drawing? {
        if let implemented = ImplementedControlRendererID(rawValue: renderer.rawValue) {
            return drawing(for: implemented)
        }
        return GenericControlRendererID(rawValue: renderer.rawValue).flatMap(drawing(for:))
    }

    private static func drawing(for renderer: ImplementedControlRendererID) -> Drawing {
        switch renderer {
        case .entityMultiSelect: .entityMultiReference
        case .amount: .amount
        case .tagList: .tokens
        case .productTags: .productTags
        case .vendorName: .text
        case .ledgerAttributions: .ledgerAttributions
        }
    }

    /// nil: drawn as the primitive of its `controlKind`, or from its `valueSchema`.
    private static func drawing(for renderer: GenericControlRendererID) -> Drawing? {
        switch renderer {
        case .entitySelect: .entityReference
        case .money: .money
        case .url: .text
        case .externalIds, .labelNutrition, .sourceAliases, .sourceRefs, .structuredField, .unitMappings,
            .upcLookup, .usdaFood:
            nil
        }
    }

    @ViewBuilder
    private var specialized: some View {
        if let schema = field.valueSchema {
            StructuredValueControl(field: field, schema: schema, model: model, pickedTitles: $pickedTitles)
        } else if let renderer = field.controlRenderer, let drawing = Self.drawing(for: renderer) {
            switch drawing {
            case .entityReference:
                if let reference = field.reference {
                    if reference.multiple { multiReference(reference) } else { singleReference(reference) }
                }
            case .entityMultiReference:
                if let reference = field.reference { multiReference(reference) }
            case .amount:
                amountControl
            case .tokens:
                tokenControl
            case .productTags:
                productTagsControl
            case .text:
                textControl
            case .money:
                moneyControl
            case .ledgerAttributions:
                LedgerAttributionsControl(
                    field: field, model: model, pickedTitles: $pickedTitles)
            }
        } else {
            EmptyView()
        }
    }

    private var textControl: some View {
        LabeledContent(label) {
            TextField(label, text: stringBinding, prompt: Text(field.placeholder ?? "None"))
                .multilineTextAlignment(.trailing)
                .labelsHidden()
        }
    }

    /// The record emoji: one large glyph, keeping only the last character typed or picked, so a
    /// replacement needs no deleting first. Mac opens the system Emoji & Symbols palette.
    private var emojiControl: some View {
        LabeledContent(label) {
            HStack(spacing: FieldGuideTokens.Space.sm) {
                #if os(macOS)
                    Button("Emoji & Symbols", systemImage: "face.smiling") {
                        NSApp.orderFrontCharacterPalette(nil)
                    }
                    .labelStyle(.iconOnly)
                    .buttonStyle(.borderless)
                #endif
                TextField(
                    label,
                    text: Binding(
                        get: { value.stringValue ?? "" },
                        set: { entry in
                            model.draft[key] = entry.last.map { .string(String($0)) } ?? .null
                        }),
                    prompt: Text(field.placeholder ?? "None").font(.body)
                )
                .font(value.stringValue?.isEmpty == false ? .largeTitle : .body)
                .multilineTextAlignment(.trailing)
                .labelsHidden()
                .accessibilityIdentifier("editor.\(model.descriptor.key.rawValue).\(key)")
            }
        }
    }

    private var moneyControl: some View {
        LabeledContent(label) {
            HStack(spacing: FieldGuideTokens.Space.xs) {
                Text(verbatim: "$").foregroundStyle(.secondary).accessibilityHidden(true)
                moneyField
            }
        }
    }

    private var moneyField: some View {
        TextField(
            label,
            value: Binding(
                get: { value.doubleValue },
                set: { model.draft[key] = $0.map(JSONValue.number) ?? .null }),
            // Entry parses a plain amount; the stored dollars display through `ValueFormat`.
            format: .number.precision(.fractionLength(0...2)).locale(Locale(identifier: "en_US")),
            prompt: Text(field.placeholder ?? "0.00")
        )
        .multilineTextAlignment(.trailing)
        .labelsHidden()
        .accessibilityIdentifier("editor.\(model.descriptor.key.rawValue).\(key)")
        #if os(iOS)
            .keyboardType(.decimalPad)
        #endif
    }

    private func singleReference(_ reference: FieldReference) -> some View {
        HStack {
            Button {
                picking = true
            } label: {
                LabeledContent(label) {
                    if let id = value.stringValue, !id.isEmpty {
                        Text(pickedTitles[id] ?? id)
                            .foregroundStyle(FieldGuideTokens.graphite)
                            .lineLimit(1)
                    } else {
                        Text("None").foregroundStyle(.secondary)
                    }
                }
                .frame(minHeight: FieldGuideTokens.touchTarget)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if let id = value.stringValue, !id.isEmpty, field.nullable {
                Button("Clear", systemImage: "xmark.circle.fill") {
                    model.stageReferenceSelection(key, value: .null)
                }
                .labelStyle(.iconOnly)
                .foregroundStyle(.secondary)
                .buttonStyle(.borderless)
                .accessibilityLabel("Clear \(field.label)")
                .accessibilityHidden(id.isEmpty)
            }
        }
        .sheet(isPresented: $picking) {
            EntityPickerSheet(
                target: reference.entity,
                selected: [value.stringValue].compactMap { $0 },
                scope: pickerScope
            ) {
                picks in
                guard let pick = picks.first else { return }
                model.stageReferenceSelection(key, value: .string(pick.id))
                pickedTitles[pick.id] = pick.title
            }
        }
    }

    private func multiReference(_ reference: FieldReference) -> some View {
        let ids = value.arrayValue?.compactMap(\.stringValue) ?? []
        return VStack(alignment: .leading, spacing: FieldGuideTokens.Space.xs) {
            Button {
                picking = true
            } label: {
                LabeledContent(label) {
                    Text(ids.isEmpty ? "None" : "\(ids.count) selected").foregroundStyle(.secondary)
                }
                .frame(minHeight: FieldGuideTokens.touchTarget)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            ForEach(ids, id: \.self) { id in
                HStack {
                    Text(pickedTitles[id] ?? id).font(.fieldGuideLabel)
                    Spacer()
                    Button("Remove", systemImage: "xmark.circle.fill") {
                        model.draft[key] = .array(ids.filter { $0 != id }.map(JSONValue.string))
                    }
                    .labelStyle(.iconOnly)
                    .foregroundStyle(.secondary)
                    .buttonStyle(.borderless)
                    .accessibilityLabel("Remove \(pickedTitles[id] ?? id)")
                }
            }
        }
        .sheet(isPresented: $picking) {
            EntityPickerSheet(
                target: reference.entity,
                multiple: true,
                selected: ids,
                scope: pickerScope
            ) { picks in
                model.draft[key] = .array(picks.map { .string($0.id) })
                for pick in picks { pickedTitles[pick.id] = pick.title }
            }
        }
    }

    private var amountControl: some View {
        LabeledContent(label) {
            HStack {
                TextField(
                    "0",
                    value: Binding(
                        get: { value["value"]?.doubleValue },
                        set: { quantity in
                            var object = value.objectValue ?? [:]
                            object["value"] = quantity.map(JSONValue.number) ?? .null
                            model.draft[key] =
                                quantity == nil && object["unit"] == nil ? .null : .object(object)
                        }),
                    format: .number
                )
                .multilineTextAlignment(.trailing)
                #if os(iOS)
                    .keyboardType(.decimalPad)
                #endif
                TextField(
                    "unit",
                    text: Binding(
                        get: { value["unit"]?.stringValue ?? "" },
                        set: { unit in
                            var object = value.objectValue ?? [:]
                            object["unit"] = unit.isEmpty ? nil : .string(unit)
                            model.draft[key] = .object(object)
                        })
                )
                .frame(maxWidth: 96)
            }
        }
    }

    private var tokenControl: some View {
        TokenListRow(
            title: label, singular: field.label.lowercased(),
            entryID: "editor.\(model.descriptor.key.rawValue).\(key).add",
            tokens: value.arrayValue?.compactMap(\.stringValue) ?? [],
            draft: $newToken, normalize: { $0.trimmingCharacters(in: .whitespaces) }
        ) { model.draft[key] = .array($0.map(JSONValue.string)) }
    }

    /// `tags` as web's `ProductTagsField` draws it: compatibility Tags and Collections
    /// (`collection:*` entries) as two lists over the one stored list, split and merged by the
    /// shared `CollectionTag` rule.
    private var productTagsControl: some View {
        let split = CollectionTag.split(value.arrayValue?.compactMap(\.stringValue) ?? [])
        return VStack(alignment: .leading, spacing: FieldGuideTokens.Space.md) {
            TokenListRow(
                title: "Tags", singular: "tag",
                entryID: "editor.\(model.descriptor.key.rawValue).\(key).add",
                tokens: split.tags, draft: $newToken,
                normalize: { $0.trimmingCharacters(in: .whitespaces) }
            ) { writeProductTags(tags: $0, collections: split.collections) }
            TokenListRow(
                title: "Collections", singular: "collection",
                entryID: "editor.\(model.descriptor.key.rawValue).\(key).collection.add",
                tokens: split.collections,
                draft: $newCollection, normalize: CollectionTag.normalizedSlug
            ) { writeProductTags(tags: split.tags, collections: $0) }
        }
    }

    private func writeProductTags(tags: [String], collections: [String]) {
        model.draft[key] = .array(
            CollectionTag.merge(tags: tags, collections: collections).map(JSONValue.string))
    }

    /// A list of removable tokens with an entry field. `normalize` shapes a typed entry; an empty
    /// or repeated one is ignored.
    // MARK: - Dates

    /// A `date` control writes `yyyy-MM-dd` for a `date` field and an ISO instant for a
    /// `timestamp`; a nullable one has an on/off toggle so it can be cleared.
    @ViewBuilder
    private var dateControl: some View {
        let isSet = value.stringValue.map { !$0.isEmpty } ?? false
        if field.nullable {
            Toggle(
                label,
                isOn: Binding(
                    get: { isSet },
                    set: {
                        model.draft[key] = $0 ? encode(.now) : .null
                        model.markEdited(key)
                    }))
        }
        if isSet || !field.nullable {
            DatePicker(
                label,
                selection: Binding(
                    get: { decode(value) ?? .now },
                    set: {
                        model.draft[key] = encode($0)
                        model.markEdited(key)
                    }),
                displayedComponents: field.kind == .timestamp ? [.date, .hourAndMinute] : .date
            )
            .labelsVisibility(field.nullable ? .hidden : .automatic)
        }
    }

    private func decode(_ value: JSONValue) -> Date? {
        guard let string = value.stringValue else { return nil }
        if field.kind == .timestamp {
            let iso = ISO8601DateFormatter()
            iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            if let date = iso.date(from: string) { return date }
            iso.formatOptions = [.withInternetDateTime]
            if let date = iso.date(from: string) { return date }
        }
        return PlainDate(rawValue: string).date()
    }

    private func encode(_ date: Date) -> JSONValue {
        if field.kind == .timestamp {
            let iso = ISO8601DateFormatter()
            iso.formatOptions = [.withInternetDateTime]
            return .string(iso.string(from: date))
        }
        return .string(PlainDate(date).rawValue)
    }

    private var stringBinding: Binding<String> {
        Binding(
            get: { value.stringValue ?? "" },
            set: { model.draft[key] = $0.isEmpty ? .null : .string($0) })
    }
}

/// A token list as one standard labelled row (the names, or None) that discloses its removable
/// tokens and entry field, so it lines up with the editor's other `LabeledContent` rows.
private struct TokenListRow: View {
    let title: String
    let singular: String
    let entryID: String
    let tokens: [String]
    @Binding var draft: String
    let normalize: (String) -> String
    let commit: ([String]) -> Void
    @State private var expanded = false

    var body: some View {
        DisclosureGroup(isExpanded: $expanded) {
            ForEach(tokens, id: \.self) { token in
                HStack {
                    Text(token)
                    Spacer()
                    Button("Remove", systemImage: "xmark.circle.fill") {
                        commit(tokens.filter { $0 != token })
                    }
                    .labelStyle(.iconOnly)
                    .foregroundStyle(.secondary)
                    .buttonStyle(.borderless)
                    .accessibilityLabel("Remove \(token)")
                }
                .frame(minHeight: FieldGuideTokens.touchTarget)
            }
            TextField("Add \(singular)", text: $draft)
                .accessibilityIdentifier(entryID)
                .onSubmit {
                    let entry = normalize(draft)
                    guard !entry.isEmpty, !tokens.contains(entry) else { return }
                    commit(tokens + [entry])
                    draft = ""
                }
        } label: {
            LabeledContent(title) {
                Text(tokens.isEmpty ? "None" : tokens.joined(separator: ", "))
                    .foregroundStyle(tokens.isEmpty ? .secondary : FieldGuideTokens.graphite)
                    .lineLimit(2)
            }
        }
    }
}

#Preview {
    @Previewable @State var draft = ""
    Form {
        TokenListRow(
            title: "Locations", singular: "location", entryID: "preview.add",
            tokens: ["Main stage", "Camp"], draft: $draft, normalize: { $0 }, commit: { _ in })
    }
}
