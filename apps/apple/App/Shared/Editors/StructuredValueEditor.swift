import CubbyKit
import SwiftUI

/// The one editor for every structured field (`externalIds`, `unitMappings`, `labelNutrition`,
/// `sourceAliases`, `sourceRefs`, `structuredField`): it draws the field's declared `ValueSchema`,
/// recursively, into `GenericEntityEditModel.draft`. There is no per-entity or per-field view;
/// validation stays on the server and its issues arrive at `model.nestedError` by position.
struct StructuredValueControl: View {
    let field: FieldDescriptor
    let schema: ValueSchema
    @Bindable var model: GenericEntityEditModel
    @Binding var pickedTitles: [String: String]

    var body: some View {
        StructuredSchemaView(
            context: StructuredEditorContext(field: field, model: model, pickedTitles: $pickedTitles),
            schema: schema,
            title: model.isRequired(field) ? "\(field.label) *" : field.label,
            path: []
        )
    }
}

/// Where the editor reads and writes: one field's draft value, addressed by path.
struct StructuredEditorContext {
    let field: FieldDescriptor
    let model: GenericEntityEditModel
    let pickedTitles: Binding<[String: String]>

    func value(_ path: [String]) -> JSONValue {
        StructuredValue.value(at: path, in: model.draft[field.key] ?? .null)
    }

    func set(_ path: [String], _ new: JSONValue) {
        model.draft[field.key] = StructuredValue.setting(
            new, at: path[...], in: model.draft[field.key] ?? .null)
    }

    func error(_ path: [String]) -> String? { model.nestedError(field.key, path: path) }

    func identifier(_ path: [String]) -> String {
        (["editor", model.descriptor.key.rawValue, field.key] + path).joined(separator: ".")
    }
}

private struct StructuredSchemaView: View {
    let context: StructuredEditorContext
    let schema: ValueSchema
    let title: String
    let path: [String]

    private var value: JSONValue { context.value(path) }

    /// Composite values are added and removed as a whole; a nullable scalar is just left empty.
    private var addedAsWhole: Bool {
        if case .amount = schema.node { return true }
        return schema.isComposite
    }

    var body: some View {
        VStack(alignment: .leading, spacing: FieldGuideTokens.Space.xs) {
            if let notice = schema.notice {
                Text(notice).font(.caption).foregroundStyle(.secondary)
            }
            if schema.nullable && addedAsWhole {
                nullableComposite
            } else {
                content
            }
            ForEach(errors, id: \.self) { message in
                Text(message)
                    .font(.caption)
                    .foregroundStyle(FieldGuideTokens.destructive)
                    .accessibilityLabel("\(title) error: \(message)")
            }
        }
    }

    /// An amount draws two controls on one path, so it also shows its parts' messages.
    private var errors: [String] {
        var paths = [path]
        if case .amount = schema.node { paths += [path + ["value"], path + ["unit"], path + ["upperValue"]] }
        return paths.compactMap(context.error)
    }

    @ViewBuilder
    private var nullableComposite: some View {
        if value == .null {
            Button("Add \(addNoun)", systemImage: "plus") {
                context.set(path, StructuredValue.blank(schema, populated: true))
            }
            .accessibilityIdentifier(context.identifier(path + ["add"]))
        } else {
            content
            Button("Remove \(addNoun)", systemImage: "minus.circle") {
                context.set(path, .null)
            }
            .foregroundStyle(FieldGuideTokens.destructive)
            .accessibilityIdentifier(context.identifier(path + ["remove"]))
        }
    }

    private var addNoun: String {
        (title.isEmpty ? "value" : title.replacingOccurrences(of: " *", with: "")).lowercased()
    }

    @ViewBuilder
    private var content: some View {
        switch schema.node {
        case .text(let format): textRow(format: format)
        case .number(let integer): numberRow(integer: integer)
        case .boolean:
            Toggle(
                title,
                isOn: Binding(
                    get: { value.boolValue ?? false }, set: { context.set(path, .bool($0)) }))
        case .enum(let options): enumRow(options)
        case .reference(let entity):
            StructuredReferenceRow(
                context: context, entity: entity, title: title, path: path, clearable: schema.nullable)
        case .amount(let upper): amountRow(upper: upper)
        case .constant: EmptyView()
        case .object(let fields): fieldRows(fields)
        case .array(let item): arrayRows(item)
        case .map(let keys, let item): mapRows(keys, item)
        case .variant(let discriminator, let cases):
            variantRows(discriminator, cases, locked: schema.createOnly == true && !context.model.isCreate)
        }
    }

    // MARK: - Scalars

    private func textRow(format: String?) -> some View {
        LabeledContent(title) {
            TextField(
                title,
                text: Binding(
                    get: { value.stringValue ?? "" },
                    set: { context.set(path, .string($0)) }),
                prompt: Text(format == "date" ? "YYYY-MM-DD" : "None")
            )
            .multilineTextAlignment(.trailing)
            .labelsHidden()
            // A structured value's text is mostly a key or code (a source, an alias, an external
            // id); autocorrect rewrote "synthetic-shop" to "synthetic-shoptalk" as it was typed.
            .autocorrectionDisabled()
            #if os(iOS)
                .textInputAutocapitalization(.never)
                .keyboardType(format == "uri" ? .URL : format == "email" ? .emailAddress : .default)
            #endif
        }
        .accessibilityIdentifier(context.identifier(path))
    }

    private func numberRow(integer: Bool) -> some View {
        LabeledContent(title) {
            TextField(
                "0",
                value: Binding(
                    get: { value.doubleValue },
                    set: { context.set(path, $0.map(JSONValue.number) ?? .null) }),
                format: .number
            )
            .multilineTextAlignment(.trailing)
            #if os(iOS)
                .keyboardType(integer ? .numberPad : .decimalPad)
            #endif
        }
        .accessibilityIdentifier(context.identifier(path))
    }

    private func enumRow(_ options: [LabeledOption]) -> some View {
        Picker(
            title,
            selection: Binding(
                get: { value.stringValue ?? "" },
                set: { context.set(path, $0.isEmpty ? .null : .string($0)) })
        ) {
            if schema.nullable || value == .null { Text("None").tag("") }
            ForEach(options, id: \.value) { Text($0.label).tag($0.value) }
        }
        .accessibilityIdentifier(context.identifier(path))
    }

    private func amountRow(upper: Bool) -> some View {
        LabeledContent(title) {
            HStack {
                TextField(
                    "0",
                    value: Binding(
                        get: { context.value(path + ["value"]).doubleValue },
                        set: { context.set(path + ["value"], $0.map(JSONValue.number) ?? .null) }),
                    format: .number
                )
                .multilineTextAlignment(.trailing)
                #if os(iOS)
                    .keyboardType(.decimalPad)
                #endif
                .accessibilityIdentifier(context.identifier(path + ["value"]))
                if upper {
                    TextField(
                        "up to",
                        value: Binding(
                            get: { context.value(path + ["upperValue"]).doubleValue },
                            set: { context.set(path + ["upperValue"], $0.map(JSONValue.number) ?? .null) }),
                        format: .number
                    )
                    .multilineTextAlignment(.trailing)
                    .frame(maxWidth: 72)
                    #if os(iOS)
                        .keyboardType(.decimalPad)
                    #endif
                    .accessibilityIdentifier(context.identifier(path + ["upperValue"]))
                }
                TextField(
                    "unit",
                    text: Binding(
                        get: { context.value(path + ["unit"]).stringValue ?? "" },
                        set: { context.set(path + ["unit"], .string($0)) })
                )
                .frame(maxWidth: 96)
                .autocorrectionDisabled()
                #if os(iOS)
                    .textInputAutocapitalization(.never)
                #endif
                .accessibilityIdentifier(context.identifier(path + ["unit"]))
            }
        }
    }

    // MARK: - Composites

    private func fieldRows(_ fields: [ValueSchema.Field]) -> some View {
        VStack(alignment: .leading, spacing: FieldGuideTokens.Space.sm) {
            if !title.isEmpty {
                Text(title).font(.fieldGuideLabel).foregroundStyle(.secondary)
            }
            ForEach(fields.filter(\.schema.isEdited), id: \.key) { child in
                StructuredSchemaView(
                    context: context, schema: child.schema,
                    title: child.required ? "\(child.label) *" : child.label,
                    path: path + [child.key])
            }
        }
    }

    private func arrayRows(_ item: ValueSchema) -> some View {
        let items = value.arrayValue ?? []
        let rowTitle = title.replacingOccurrences(of: " *", with: "")
        return VStack(alignment: .leading, spacing: FieldGuideTokens.Space.sm) {
            Text(title).font(.fieldGuideLabel).foregroundStyle(.secondary)
            ForEach(items.indices, id: \.self) { index in
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: FieldGuideTokens.Space.xs) {
                        if item.isComposite {
                            Text("\(rowTitle) \(index + 1)").font(.fieldGuideLabel.weight(.semibold))
                        }
                        StructuredSchemaView(
                            context: context, schema: item,
                            title: item.isComposite ? "" : "\(rowTitle) \(index + 1)",
                            path: path + [String(index)])
                    }
                    Button("Remove", systemImage: "minus.circle.fill") {
                        var next = items
                        next.remove(at: index)
                        context.set(path, .array(next))
                    }
                    .labelStyle(.iconOnly)
                    .foregroundStyle(FieldGuideTokens.destructive)
                    .buttonStyle(.borderless)
                    .frame(minHeight: FieldGuideTokens.touchTarget)
                    .accessibilityLabel("Remove \(rowTitle) \(index + 1)")
                    .accessibilityIdentifier(context.identifier(path + [String(index), "remove"]))
                }
                if index < items.count - 1 { Divider() }
            }
            Button("Add \(rowTitle.lowercased())", systemImage: "plus") {
                context.set(path, .array(items + [StructuredValue.blank(item, populated: true)]))
            }
            .accessibilityIdentifier(context.identifier(path + ["add"]))
        }
    }

    private func mapRows(_ keys: [LabeledOption], _ item: ValueSchema) -> some View {
        let entries = value.objectValue ?? [:]
        let present = keys.filter { entries[$0.value] != nil }
        let absent = keys.filter { entries[$0.value] == nil }
        return VStack(alignment: .leading, spacing: FieldGuideTokens.Space.sm) {
            Text(title).font(.fieldGuideLabel).foregroundStyle(.secondary)
            ForEach(present, id: \.value) { option in
                HStack {
                    StructuredSchemaView(
                        context: context, schema: item, title: option.label,
                        path: path + [option.value])
                    Button("Remove", systemImage: "minus.circle.fill") {
                        var next = entries
                        next.removeValue(forKey: option.value)
                        context.set(path, .object(next))
                    }
                    .labelStyle(.iconOnly)
                    .foregroundStyle(FieldGuideTokens.destructive)
                    .buttonStyle(.borderless)
                    .accessibilityLabel("Remove \(option.label)")
                }
            }
            if !absent.isEmpty {
                Menu {
                    ForEach(absent, id: \.value) { option in
                        Button(option.label) {
                            var next = entries
                            next[option.value] = StructuredValue.blank(item, populated: true)
                            context.set(path, .object(next))
                        }
                    }
                } label: {
                    Label("Add", systemImage: "plus")
                }
                .accessibilityIdentifier(context.identifier(path + ["add"]))
            }
        }
    }

    private func variantRows(_ discriminator: String, _ cases: [ValueSchema.Case], locked: Bool) -> some View
    {
        let tag = value[discriminator]?.stringValue
        let selected = cases.first { $0.value == tag }
        let pickerTitle = title.isEmpty ? discriminator.capitalized : "\(title) \(discriminator)"
        return VStack(alignment: .leading, spacing: FieldGuideTokens.Space.sm) {
            Picker(
                pickerTitle,
                selection: Binding(
                    get: { tag ?? "" },
                    set: { chosen in
                        guard chosen != tag, let next = cases.first(where: { $0.value == chosen }) else {
                            return
                        }
                        context.set(path, StructuredValue.blankCase(discriminator, next))
                    })
            ) {
                if selected == nil { Text("Choose").tag("") }
                ForEach(cases, id: \.value) { Text($0.label).tag($0.value) }
            }
            .disabled(locked)
            .accessibilityIdentifier(context.identifier(path + [discriminator]))
            if let selected { fieldRows(selected.fields) }
        }
    }
}

/// A shortcode field the person picks from the target entity's records rather than typing.
private struct StructuredReferenceRow: View {
    let context: StructuredEditorContext
    let entity: EntityKey
    let title: String
    let path: [String]
    let clearable: Bool
    @State private var picking = false

    private var id: String? {
        context.value(path).stringValue.flatMap { $0.isEmpty ? nil : $0 }
    }

    var body: some View {
        HStack {
            Button {
                picking = true
            } label: {
                LabeledContent(title) {
                    if let id {
                        Text(context.pickedTitles.wrappedValue[id] ?? id)
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
            .accessibilityIdentifier(context.identifier(path))
            if id != nil, clearable {
                Button("Clear", systemImage: "xmark.circle.fill") { context.set(path, .null) }
                    .labelStyle(.iconOnly)
                    .foregroundStyle(.secondary)
                    .buttonStyle(.borderless)
                    .accessibilityLabel("Clear \(title)")
            }
        }
        .sheet(isPresented: $picking) {
            EntityPickerSheet(target: entity, selected: [id].compactMap { $0 }) { picks in
                guard let pick = picks.first else { return }
                context.set(path, .string(pick.id))
                context.pickedTitles.wrappedValue[pick.id] = pick.title
            }
        }
    }
}

extension ValueSchema {
    /// An object, list or other value drawn as a titled group rather than one row.
    fileprivate var isComposite: Bool {
        switch node {
        case .object, .array, .map, .variant: true
        default: false
        }
    }
}

#Preview("Product unit mappings and label nutrition") {
    @Previewable @State var pickedTitles: [String: String] = [:]
    let model = GenericEntityEditModel(
        descriptor: EntityCatalog[.product], mode: .update(id: "PRD-2345"),
        client: PreviewFixtures.signedInModel().client,
        original: [
            "id": "PRD-2345",
            "unitMappings": [
                ["a": ["value": 1, "unit": "cup"], "b": ["value": 120, "unit": "g"], "source": "manual"]
            ],
            "labelNutrition": ["servingGrams": 44, "nutrients": ["protein": 3, "fat": 1.5], "source": nil],
        ])
    return Form {
        ForEach(["unitMappings", "labelNutrition"], id: \.self) { key in
            if let field = EntityCatalog[.product].field(key), let schema = field.valueSchema {
                StructuredValueControl(
                    field: field, schema: schema, model: model, pickedTitles: $pickedTitles)
            }
        }
    }
    .environment(PreviewFixtures.signedInModel())
}

#Preview("Financial account identity") {
    @Previewable @State var pickedTitles: [String: String] = [:]
    let model = GenericEntityEditModel(
        descriptor: EntityCatalog[.financialAccount], mode: .create(prefill: [:]),
        client: PreviewFixtures.signedInModel().client)
    return Form {
        if let field = EntityCatalog[.financialAccount].field("identity"), let schema = field.valueSchema {
            StructuredValueControl(field: field, schema: schema, model: model, pickedTitles: $pickedTitles)
        }
    }
    .environment(PreviewFixtures.signedInModel())
}
