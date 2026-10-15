import CubbyKit
import SwiftUI

/// The one sheet for every manifest hero action that needs input or a confirmation. It renders
/// the plan's declared fields, shows the server's preview (a discard warning, a delete impact),
/// and asks for an explicit confirmation before a destructive plan runs. Which operation a verb
/// calls is `HeroActionRunner`'s; nothing here is per entity.
struct HeroActionSheet: View {
    let model: HeroActionModel
    let onFinished: (HeroActionOutcome) -> Void

    @Environment(AppModel.self) private var appModel
    @Environment(\.dismiss) private var dismiss
    @State private var confirming = false
    @State private var pickingLocation = false
    @State private var pickedLocationTitle: String?

    private var isDestructive: Bool { model.plan.confirmation == .destructive }

    var body: some View {
        NavigationStack {
            Form {
                summarySection
                inputSection
                previewSection
                if let message = model.errorMessage {
                    Section { Text(message).foregroundStyle(.red) }
                }
            }
            .navigationTitle(model.plan.label)
            #if os(iOS)
                .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(model.plan.label, role: isDestructive ? .destructive : nil) {
                        if isDestructive { confirming = true } else { run(confirmed: false) }
                    }
                    .disabled(!model.canSubmit)
                    .accessibilityIdentifier("heroAction.submit")
                }
            }
            .confirmationDialog(
                "\(model.plan.label) \(model.row.title)?", isPresented: $confirming, titleVisibility: .visible
            ) {
                Button(model.plan.label, role: .destructive) { run(confirmed: true) }
            } message: {
                Text(model.plan.kind == .delete ? "This cannot be undone." : "This records the change now.")
            }
            .sheet(isPresented: $pickingLocation) {
                EntityPickerSheet(target: .location) { picks in
                    guard let pick = picks.first else { return }
                    model.setValue("location", .string(pick.id))
                    pickedLocationTitle = pick.title
                }
                .environment(appModel)
            }
            .task(id: model.values) {
                // Debounced: a preview per keystroke would race the typing it describes.
                try? await Task.sleep(for: .milliseconds(250))
                guard !Task.isCancelled else { return }
                await model.refreshPreview()
            }
        }
    }

    @ViewBuilder private var summarySection: some View {
        Section {
            Text(model.row.title).font(.headline)
            if model.plan.kind == .delete {
                Text("This permanently removes the record. Connected records are listed below.")
                    .foregroundStyle(.secondary)
            }
        }
    }

    @ViewBuilder private var inputSection: some View {
        if case .setField(let field) = model.plan.kind {
            Section(EntityCatalog[model.entity].fields.first { $0.key == field }?.label ?? field) {
                Picker("Value", selection: stringBinding(field)) {
                    ForEach(
                        EntityCatalog[model.entity].fields.first { $0.key == field }?.controlOptions ?? [],
                        id: \.value
                    ) {
                        Text($0.label).tag($0.value)
                    }
                }
                .pickerStyle(.inline)
                .labelsHidden()
            }
        } else if !model.visibleFields.isEmpty {
            Section {
                ForEach(model.visibleFields) { field in control(for: field) }
            }
        }
    }

    @ViewBuilder private func control(for field: HeroActionField) -> some View {
        switch field.kind {
        case .number:
            // A filled number field loses its placeholder, so the label has to be visible beside it.
            LabeledContent(field.label) {
                TextField(field.label, value: numberBinding(field.key), format: .number)
                    .multilineTextAlignment(.trailing)
                    #if os(iOS)
                        .keyboardType(.decimalPad)
                    #endif
            }
        case .text:
            LabeledContent(field.label) {
                TextField(field.label, text: stringBinding(field.key))
                    .multilineTextAlignment(.trailing)
            }
        case .date:
            DatePicker(field.label, selection: dateBinding(field.key), displayedComponents: .date)
        case .toggle:
            Toggle(field.label, isOn: boolBinding(field.key))
        case .choice:
            Picker(field.label, selection: stringBinding(field.key)) {
                ForEach(field.options ?? [], id: \.value) { Text($0.label).tag($0.value) }
            }
        case .location:
            Button {
                pickingLocation = true
            } label: {
                LabeledContent(field.label, value: pickedLocationTitle ?? "Choose a location")
            }
        case .amount:
            if let existing = model.existingStock {
                Text(existing).font(.caption).foregroundStyle(.secondary)
            }
            HStack {
                TextField(field.label, value: amountValueBinding(field.key), format: .number)
                    #if os(iOS)
                        .keyboardType(.decimalPad)
                    #endif
                TextField("Unit", text: amountUnitBinding(field.key))
                    .frame(maxWidth: 100)
            }
        case .shelf:
            Picker(field.label, selection: stringBinding(field.key)) {
                Text("Choose a shelf").tag("")
                ForEach(model.shelfOptions, id: \.value) { Text($0.label).tag($0.value) }
            }
        }
    }

    @ViewBuilder private var previewSection: some View {
        if let advisory = model.advisory {
            Section {
                Label(
                    advisory.message,
                    systemImage: advisory.isDestructive
                        ? "exclamationmark.octagon" : "exclamationmark.triangle"
                )
                .foregroundStyle(advisory.isDestructive ? .red : .orange)
            }
        }
        if case .deleteImpact(let impact)? = model.preview {
            let incoming = impact.groups.filter { $0.direction == .incoming }
            Section("Connections affected") {
                if incoming.isEmpty {
                    Text("No incoming connections").foregroundStyle(.secondary)
                }
                ForEach(incoming, id: \.edgeKey) { group in
                    VStack(alignment: .leading) {
                        Text("\(group.label) · \(group.count)")
                        Text(group.disposition?.description ?? "No disposition declared")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
                Text("This preview is advisory. The delete checks the connections again when it runs.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        } else if let error = model.previewError {
            Section { Text(error).foregroundStyle(.secondary) }
        }
    }

    private func run(confirmed: Bool) {
        model.submit(confirmed: confirmed) { outcome in
            dismiss()
            onFinished(outcome)
        }
    }

    // MARK: - Bindings over the model's JSON values

    private func stringBinding(_ key: String) -> Binding<String> {
        Binding(
            get: { model.values[key]?.stringValue ?? "" },
            set: { model.setValue(key, .string($0)) })
    }

    private func boolBinding(_ key: String) -> Binding<Bool> {
        Binding(
            get: { model.values[key]?.boolValue ?? false },
            set: { model.setValue(key, .bool($0)) })
    }

    private func numberBinding(_ key: String) -> Binding<Double?> {
        Binding(
            get: { model.values[key]?.doubleValue },
            set: { model.setValue(key, $0.map(JSONValue.number) ?? .null) })
    }

    private func amountValueBinding(_ key: String) -> Binding<Double?> {
        Binding(
            get: { model.values[key]?["value"]?.doubleValue },
            set: { value in
                var amount = model.values[key]?.objectValue ?? [:]
                amount["value"] = value.map(JSONValue.number) ?? .null
                model.setValue(key, .object(amount))
            })
    }

    private func amountUnitBinding(_ key: String) -> Binding<String> {
        Binding(
            get: { model.values[key]?["unit"]?.stringValue ?? "" },
            set: { unit in
                var amount = model.values[key]?.objectValue ?? [:]
                amount["unit"] = .string(unit)
                model.setValue(key, .object(amount))
            })
    }

    private func dateBinding(_ key: String) -> Binding<Date> {
        Binding(
            get: { model.values[key]?.stringValue.flatMap { PlainDate(rawValue: $0).date() } ?? Date() },
            set: { model.setValue(key, .string(PlainDate($0).rawValue)) })
    }
}
