import CubbyKit
import SwiftUI

/// One editor control for one catalog field, chosen by `controlKind` × `kind`. A locked field
/// (`readOnlyOnUpdate`/`readOnlyWhen`) renders as a disabled `LabeledContent` and never enters
/// the patch. Errors from the last save render as the row's footer.
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

    var body: some View {
        VStack(alignment: .leading, spacing: FieldGuideTokens.Space.xs) {
            if model.readOnly(key) {
                LabeledContent(field.label) {
                    Text(lockedDisplay).foregroundStyle(.secondary)
                }
                .disabled(true)
                .accessibilityHint("Read-only")
            } else {
                control
            }
            if let resolved = model.resolutionForEditor(field) {
                Text("Effective: \(EntityFieldValue.text(resolved.effectiveValue, field: field) ?? "None")")
                    .font(.caption).foregroundStyle(.secondary)
                EntityFieldResolutionLabel(resolved: resolved)
                if resolved.resetPayload(field: field) != nil, !model.readOnly(key) {
                    Button(resolved.resetLabel) { model.stageResolutionReset(key) }
                        .accessibilityIdentifier("editor.\(model.descriptor.key.rawValue).\(key).reset")
                    Text("Save commits the reset.").font(.caption).foregroundStyle(.secondary)
                }
            } else if let original = model.original,
                FieldResolutionPresentation(raw: original, field: field) != nil
            {
                Text("Saved resolution is out of date for this draft. Save to refresh.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            if field.resolution?.none != nil, !model.readOnly(key) {
                Button("Use no value") { model.stageResolutionNone(key) }
                    .accessibilityIdentifier("editor.\(model.descriptor.key.rawValue).\(key).none")
            }
            if let error = model.fieldErrors[key] {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(FieldGuideTokens.destructive)
                    .accessibilityLabel("\(field.label) error: \(error)")
            }
        }
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

    private var lockedDisplay: String {
        if let reference = EntityFieldValue.reference(in: model.original ?? .null, field: field) {
            return reference.name ?? reference.id
        }
        return EntityFieldValue.text(value, field: field) ?? "—"
    }

    @ViewBuilder
    private var control: some View {
        switch field.controlKind {
        case .text:
            LabeledContent(label) {
                TextField(label, text: stringBinding, prompt: Text(field.placeholder ?? "None"))
                    .multilineTextAlignment(.trailing)
                    .labelsHidden()
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
                    field.placeholder ?? "0",
                    value: Binding(
                        get: { value.doubleValue },
                        set: { model.draft[key] = $0.map(JSONValue.number) ?? .null }),
                    format: .number
                )
                .multilineTextAlignment(.trailing)
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

    /// The native control a specialized renderer draws. nil means none: a renderer only web
    /// draws (the image block's `.imageOrder`, any id a future field declares) draws nothing, and
    /// `NativePresentationCoverage.control` reports it unsupported. A field with a declared
    /// `valueSchema` (the structured renderers, `generic` in `native-coverage.ts`) is drawn by
    /// `StructuredValueControl` whatever its renderer. Every other renderer is exactly the set
    /// `native-coverage.ts` marks `implemented` or `generic`; `NativeCoverageViewPathTests` fails
    /// when they differ.
    enum Drawing {
        case entityReference, entityMultiReference, amount, tokens, productTags, text, money,
            ledgerAttributions
    }

    static func drawing(for renderer: ControlRendererID) -> Drawing? {
        switch renderer {
        case .entitySelect: .entityReference
        case .entityMultiSelect: .entityMultiReference
        case .amount: .amount
        case .tagList: .tokens
        case .productTags: .productTags
        case .vendorName, .url: .text
        case .money: .money
        case .ledgerAttributions: .ledgerAttributions
        default: nil
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

    private var moneyControl: some View {
        LabeledContent(label) {
            TextField(
                field.placeholder ?? "0",
                value: Binding(
                    get: { value.doubleValue },
                    set: { model.draft[key] = $0.map(JSONValue.number) ?? .null }),
                format: .usd
            )
            .multilineTextAlignment(.trailing)
        }
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
                Button("Clear", systemImage: "xmark.circle.fill") { model.draft[key] = .null }
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
                model.draft[key] = .string(pick.id)
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
        tokenEditor(
            title: label, singular: field.label.lowercased(),
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
            tokenEditor(
                title: "Tags", singular: "tag", tokens: split.tags, draft: $newToken,
                normalize: { $0.trimmingCharacters(in: .whitespaces) }
            ) { writeProductTags(tags: $0, collections: split.collections) }
            tokenEditor(
                title: "Collections", singular: "collection", tokens: split.collections,
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
    private func tokenEditor(
        title: String, singular: String, tokens: [String], draft: Binding<String>,
        normalize: @escaping (String) -> String, commit: @escaping ([String]) -> Void
    ) -> some View {
        VStack(alignment: .leading, spacing: FieldGuideTokens.Space.xs) {
            Text(title).font(.fieldGuideLabel).foregroundStyle(.secondary)
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
            TextField("Add \(singular)", text: draft)
                .onSubmit {
                    let entry = normalize(draft.wrappedValue)
                    guard !entry.isEmpty, !tokens.contains(entry) else { return }
                    commit(tokens + [entry])
                    draft.wrappedValue = ""
                }
        }
    }

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
        return PlainDate(rawValue: string).date
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
