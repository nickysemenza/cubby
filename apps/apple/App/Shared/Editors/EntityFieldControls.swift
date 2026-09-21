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

    private var key: String { field.key }
    private var value: JSONValue { model.draft[key] ?? .null }
    private var pickerScope: EntityPickerScope? {
        EntityReferenceScope.pickerScope(field: field, draft: model.draft)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: PorcelainTokens.Space.xs) {
            if model.readOnly(key) {
                LabeledContent(field.label) {
                    Text(lockedDisplay).foregroundStyle(.secondary)
                }
                .disabled(true)
                .accessibilityHint("Read-only")
            } else {
                control
            }
            if let error = model.fieldErrors[key] {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(PorcelainTokens.destructive)
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
            VStack(alignment: .leading, spacing: PorcelainTokens.Space.xs) {
                Text(label).font(.porcelainLabel).foregroundStyle(.secondary)
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

    /// Dispatches the generated semantic renderer first. Generic entity-select/money/url
    /// renderers still use the same primitive controls as their `controlKind`; specialized
    /// amount, multi-select, tags, vendor-name, and ledger-attribution controls keep their typed
    /// behavior.
    @ViewBuilder
    private var specialized: some View {
        if let renderer = field.controlRenderer {
            switch renderer {
            case .entitySelect:
                if let reference = field.reference {
                    if reference.multiple { multiReference(reference) } else { singleReference(reference) }
                }
            case .entityMultiSelect:
                if let reference = field.reference { multiReference(reference) }
            case .amount:
                amountControl
            case .tagList:
                tokenControl
            case .vendorName, .url:
                textControl
            case .money:
                moneyControl
            case .ledgerAttributions:
                LedgerAttributionsControl(
                    field: field, model: model, pickedTitles: $pickedTitles)
            case .imageOrder, .structuredField:
                EmptyView()
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
                format: .currency(code: "USD")
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
                            .foregroundStyle(PorcelainTokens.graphite)
                            .lineLimit(1)
                    } else {
                        Text("None").foregroundStyle(.secondary)
                    }
                }
                .frame(minHeight: PorcelainTokens.touchTarget)
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
        return VStack(alignment: .leading, spacing: PorcelainTokens.Space.xs) {
            Button {
                picking = true
            } label: {
                LabeledContent(label) {
                    Text(ids.isEmpty ? "None" : "\(ids.count) selected").foregroundStyle(.secondary)
                }
                .frame(minHeight: PorcelainTokens.touchTarget)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            ForEach(ids, id: \.self) { id in
                HStack {
                    Text(pickedTitles[id] ?? id).font(.porcelainLabel)
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
        let tokens = value.arrayValue?.compactMap(\.stringValue) ?? []
        return VStack(alignment: .leading, spacing: PorcelainTokens.Space.xs) {
            Text(label).font(.porcelainLabel).foregroundStyle(.secondary)
            ForEach(tokens, id: \.self) { token in
                HStack {
                    Text(token)
                    Spacer()
                    Button("Remove", systemImage: "xmark.circle.fill") {
                        model.draft[key] = .array(tokens.filter { $0 != token }.map(JSONValue.string))
                    }
                    .labelStyle(.iconOnly)
                    .foregroundStyle(.secondary)
                    .buttonStyle(.borderless)
                    .accessibilityLabel("Remove \(token)")
                }
                .frame(minHeight: PorcelainTokens.touchTarget)
            }
            TextField("Add \(field.label.lowercased())", text: $newToken)
                .onSubmit {
                    let trimmed = newToken.trimmingCharacters(in: .whitespaces)
                    guard !trimmed.isEmpty, !tokens.contains(trimmed) else { return }
                    model.draft[key] = .array((tokens + [trimmed]).map(JSONValue.string))
                    newToken = ""
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
