import CubbyKit
import SwiftUI

/// Edits an Expense's weighted ledger-party attribution array inside the generic entity form.
/// Weights are relative shares, and the field key supplies the distinct beneficiary/funder copy.
struct LedgerAttributionsControl: View {
    let field: FieldDescriptor
    @Bindable var model: GenericEntityEditModel
    @Binding var pickedTitles: [String: String]

    @State private var pickerTarget: PartyPickerTarget?
    @State private var attributionError: String?

    private let maximumWeight = 9_007_199_254_740_991

    private var attributions: [JSONValue] {
        model.draft[field.key]?.arrayValue ?? []
    }

    private var roleNoun: String {
        field.key == "funders" ? "funder" : "beneficiary"
    }

    private var rolePrompt: String {
        field.key == "funders" ? "Who paid for this expense?" : "Who benefited from this expense?"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: PorcelainTokens.Space.md) {
            VStack(alignment: .leading, spacing: 2) {
                Text(field.label)
                    .font(.porcelainLabel.weight(.semibold))
                    .foregroundStyle(PorcelainTokens.graphite)
                Text(rolePrompt)
                    .font(.caption)
                    .foregroundStyle(PorcelainTokens.graphiteSecondary)
            }

            ForEach(attributions.indices, id: \.self) { index in
                attributionRow(index)
            }

            Menu {
                Button("Choose ledger party…") {
                    pickerTarget = PartyPickerTarget(index: nil)
                }
                Button("Add unattributed share") { append(partyID: nil, name: nil) }
                    .disabled(attributions.indices.contains { partyID(at: $0) == nil })
            } label: {
                Label("Add \(roleNoun)", systemImage: "plus")
            }
            .accessibilityIdentifier("editor.expense.\(field.key).add")

            Text("Weights are relative shares. Equal weights split the expense equally.")
                .font(.caption)
                .foregroundStyle(PorcelainTokens.graphiteSecondary)

            if let attributionError {
                Label(attributionError, systemImage: "exclamationmark.circle")
                    .font(.caption)
                    .foregroundStyle(PorcelainTokens.destructive)
            }
        }
        .sheet(item: $pickerTarget) { target in
            EntityPickerSheet(
                target: .ledgerParty,
                selected: target.index.flatMap { partyID(at: $0) }.map { [$0] } ?? []
            ) { picks in
                guard let party = picks.first else { return }
                assign(partyID: party.id, name: party.title, at: target.index)
            }
        }
    }

    private func attributionRow(_ index: Int) -> some View {
        VStack(alignment: .leading, spacing: PorcelainTokens.Space.sm) {
            HStack {
                Button {
                    pickerTarget = PartyPickerTarget(index: index)
                } label: {
                    LabeledContent("Ledger party", value: partyLabel(at: index))
                        .frame(minHeight: PorcelainTokens.touchTarget)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                Button("Remove", systemImage: "minus.circle.fill") {
                    remove(at: index)
                }
                .labelStyle(.iconOnly)
                .foregroundStyle(PorcelainTokens.destructive)
                .buttonStyle(.borderless)
                .accessibilityLabel("Remove \(partyLabel(at: index))")
            }

            LabeledContent("Share weight") {
                HStack(spacing: PorcelainTokens.Space.sm) {
                    TextField("Weight", value: weightBinding(at: index), format: .number)
                        .multilineTextAlignment(.trailing)
                        #if os(iOS)
                            .keyboardType(.numberPad)
                        #endif
                        .frame(minWidth: 64)
                    Stepper(
                        "Weight", value: weightBinding(at: index), in: 1...maximumWeight
                    )
                    .labelsHidden()
                }
            }
        }
        .padding(.vertical, PorcelainTokens.Space.xs)
        .accessibilityIdentifier("editor.expense.\(field.key).row.\(index)")
    }

    private func partyID(at index: Int) -> String? {
        guard attributions.indices.contains(index) else { return nil }
        return attributions[index]["partyId"]?.stringValue
    }

    private func partyLabel(at index: Int) -> String {
        guard let partyID = partyID(at: index) else { return "Unattributed" }
        return pickedTitles[partyID] ?? partyID
    }

    private func weight(at index: Int) -> Int {
        guard attributions.indices.contains(index),
            let value = attributions[index]["weight"]?.doubleValue,
            value >= 1, value <= Double(maximumWeight)
        else { return 1 }
        return Int(value)
    }

    private func weightBinding(at index: Int) -> Binding<Int> {
        Binding(
            get: { weight(at: index) },
            set: { setWeight(min(max($0, 1), maximumWeight), at: index) }
        )
    }

    private func assign(partyID: String, name: String, at index: Int?) {
        if let duplicateIndex = attributions.indices.first(where: {
            $0 != index && self.partyID(at: $0) == partyID
        }) {
            attributionError =
                "\(pickedTitles[partyID] ?? name) is already listed at row \(duplicateIndex + 1)."
            return
        }
        attributionError = nil
        pickedTitles[partyID] = name
        if let index {
            replace(at: index, partyID: partyID, weight: weight(at: index))
        } else {
            append(partyID: partyID, name: name)
        }
    }

    private func append(partyID: String?, name: String?) {
        if partyID == nil, attributions.indices.contains(where: { self.partyID(at: $0) == nil }) {
            attributionError = "An unattributed share is already listed."
            return
        }
        attributionError = nil
        if let partyID, let name { pickedTitles[partyID] = name }
        var updated = attributions
        guard let value = encoded(partyID: partyID, weight: 1) else { return }
        updated.append(value)
        model.draft[field.key] = .array(updated)
    }

    private func setWeight(_ weight: Int, at index: Int) {
        replace(at: index, partyID: partyID(at: index), weight: weight)
    }

    private func replace(at index: Int, partyID: String?, weight: Int) {
        guard attributions.indices.contains(index), let value = encoded(partyID: partyID, weight: weight)
        else { return }
        var updated = attributions
        updated[index] = value
        model.draft[field.key] = .array(updated)
    }

    private func remove(at index: Int) {
        guard attributions.indices.contains(index) else { return }
        var updated = attributions
        updated.remove(at: index)
        model.draft[field.key] = .array(updated)
        attributionError = nil
    }

    private func encoded(partyID: LedgerPartyShortcode?, weight: Int) -> JSONValue? {
        try? JSONValue(encoding: LedgerAttributionInputRequest(partyId: partyID, weight: weight))
    }
}

private struct PartyPickerTarget: Identifiable {
    let index: Int?
    var id: String { index.map(String.init) ?? "new" }
}

#Preview("Expense beneficiaries") {
    @Previewable @State var pickedTitles = ["LPY-1234": "Alex"]
    let model = GenericEntityEditModel(
        descriptor: EntityCatalog[.expense], mode: .create(prefill: [:]),
        client: PreviewFixtures.signedInModel().client)
    model.draft["beneficiaries"] = [
        ["partyId": "LPY-1234", "weight": 2],
        ["partyId": nil, "weight": 1],
    ]
    return Form {
        LedgerAttributionsControl(
            field: EntityCatalog[.expense].field("beneficiaries")!, model: model,
            pickedTitles: $pickedTitles)
    }
    .environment(PreviewFixtures.signedInModel())
}
