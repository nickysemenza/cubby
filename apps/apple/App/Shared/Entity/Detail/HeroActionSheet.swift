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
    @State private var draftDismissal = DraftDismissalState()

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
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        draftDismissal.request(
                            isDirty: model.hasEdits, isSaving: model.isRunning, dismiss: dismiss)
                    }
                    .disabled(model.isRunning)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(role: isDestructive ? .destructive : nil) {
                        if isDestructive { confirming = true } else { run(confirmed: false) }
                    } label: {
                        if model.isRunning {
                            ProgressView { Text("\(model.plan.label)…") }
                        } else {
                            Text(model.plan.label)
                        }
                    }
                    .disabled(!model.canSubmit)
                    .accessibilityIdentifier("heroAction.submit")
                }
            }
            .draftDismissal(
                $draftDismissal, isDirty: model.hasEdits, isSaving: model.isRunning
            ) { dismiss() }
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
        if case .setField(let field, nil) = model.plan.kind {
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
        } else if case .editField(let field) = model.plan.kind {
            let descriptor = EntityCatalog[model.entity].fields.first { $0.key == field }
            let label = descriptor?.label ?? field
            Section {
                if descriptor?.controlRenderer == .amount {
                    amountControl(key: field, label: label)
                } else if descriptor?.kind == .number {
                    numberControl(key: field, label: label)
                } else {
                    LabeledContent(label) {
                        TextField(label, text: stringBinding(field)).multilineTextAlignment(.trailing)
                    }
                }
            }
        } else if !model.visibleFields.isEmpty {
            Section {
                ForEach(model.visibleFields) { field in control(for: field) }
            }
        }
    }

    // A filled number field loses its placeholder, so the label has to be visible beside it.
    private func numberControl(key: String, label: String) -> some View {
        LabeledContent(label) {
            TextField(label, value: numberBinding(key), format: .number)
                .multilineTextAlignment(.trailing)
                #if os(iOS)
                    .keyboardType(.decimalPad)
                #endif
        }
    }

    @ViewBuilder private func amountControl(key: String, label: String) -> some View {
        LabeledContent(label) {
            TextField(label, value: amountValueBinding(key), format: .number, prompt: Text("0"))
                .multilineTextAlignment(.trailing)
                .labelsHidden()
                .textFieldStyle(.roundedBorder)
                #if os(iOS)
                    .keyboardType(.decimalPad)
                #endif
        }
        LabeledContent("Unit") {
            TextField("Unit", text: amountUnitBinding(key), prompt: Text("unit"))
                .multilineTextAlignment(.trailing)
                .labelsHidden()
                .textFieldStyle(.roundedBorder)
                .autocorrectionDisabled()
                #if os(iOS)
                    .textInputAutocapitalization(.never)
                #endif
        }
    }

    @ViewBuilder private func control(for field: HeroActionField) -> some View {
        switch field.kind {
        case .number:
            numberControl(key: field.key, label: field.label)
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
            amountControl(key: field.key, label: field.label)
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
