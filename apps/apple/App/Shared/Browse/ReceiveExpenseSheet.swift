import CubbyAPISupport
import CubbyKit
import SwiftUI

extension ReceivingModel: Identifiable {
    public nonisolated var id: ObjectIdentifier { ObjectIdentifier(self) }
}

/// "Receive into Inventory" for one Expense line that names a Product. The presenter owns the
/// model, so each presentation starts from fresh stock (see apps/apple/AGENTS.md on sheet state).
struct ReceiveExpenseButton: View {
    let expenseID: String
    let productID: String
    @Environment(AppModel.self) private var appModel
    @State private var receiving: ReceivingModel?

    var body: some View {
        Button {
            receiving = ReceivingModel(
                expenseID: expenseID, productID: ProductCode(productID), service: appModel.client)
        } label: {
            Label("Receive into Inventory", systemImage: "tray.and.arrow.down")
        }
        .accessibilityIdentifier("receive.open.\(expenseID)")
        .sheet(item: $receiving) { model in
            ReceiveExpenseSheet(model: model)
        }
    }
}

/// `purchase.receiving`: every Product line opens the same per-line sheet. Importing a purchase
/// never counts stock; a line is received only for units that actually arrived.
struct PurchaseReceivingSlot: View {
    let purchaseID: String
    @Environment(AppModel.self) private var appModel
    @State private var lines: [EntityRow]?
    @State private var error: String?

    private var productLines: [EntityRow] {
        (lines ?? []).filter { $0.raw["productId"]?.stringValue != nil }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: FieldGuideTokens.Space.sm) {
            if let error {
                Text(error).foregroundStyle(.red)
                Button("Retry") { Task { await load() } }
            } else if lines == nil {
                LoadingIndicator(label: "Loading lines")
            } else if productLines.isEmpty {
                Text("No line on this purchase names a Product to receive.").foregroundStyle(.secondary)
            } else {
                Text(
                    "Importing a purchase never counts stock. Receive a line only for units that actually arrived."
                )
                .font(.caption).foregroundStyle(.secondary)
                ForEach(productLines) { line in
                    HStack {
                        VStack(alignment: .leading) {
                            Text(line.title).font(.subheadline)
                            if let name = line.raw["productName"]?.stringValue {
                                Text(name).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                        Spacer()
                        if let productID = line.raw["productId"]?.stringValue {
                            ReceiveExpenseButton(expenseID: line.id, productID: productID)
                                .labelStyle(.titleOnly)
                                .buttonStyle(.borderless)
                        }
                    }
                }
            }
        }
        .task(id: purchaseID) { await load() }
    }

    private func load() async {
        do {
            let page = try await appModel.client.list(
                EntityCatalog[.expense], pageSize: 100,
                filters: EntityFilterState(["purchaseId": .many([purchaseID])]))
            lines = page.items
            error = nil
        } catch {
            self.error = error.userMessage
            Diagnostics.report(error, context: "receive.lines")
        }
    }
}

struct ReceiveExpenseSheet: View {
    @Bindable var model: ReceivingModel
    @Environment(AppModel.self) private var appModel
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Group {
                switch model.phase {
                case .loading:
                    LoadingIndicator(label: "Checking existing stock")
                case .failed(let message):
                    ContentUnavailableView {
                        Label("Could not load stock", systemImage: "exclamationmark.triangle")
                    } description: {
                        Text(message)
                    } actions: {
                        Button("Retry") { Task { await model.load() } }
                    }
                case .loaded:
                    form
                }
            }
            .navigationTitle("Receive into Inventory")
            #if os(iOS)
                .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Receive") { Task { await model.receive() } }
                        .disabled(!model.canReceive)
                        .accessibilityIdentifier("receive.confirm")
                }
            }
            .task { await model.load() }
            .onChange(of: model.didReceive) { _, received in if received { dismiss() } }
        }
        .nativeSheet(.editor)
    }

    private var form: some View {
        Form {
            if let snapshot = model.snapshot, model.alreadyCounted {
                countedSection(snapshot)
            }
            if model.decision == .additionalUnits {
                destinationSection
            }
            if let refusal = model.refusal {
                Section {
                    Text(refusal).foregroundStyle(.red).textSelection(.enabled)
                        .accessibilityIdentifier("receive.refusal")
                }
            }
        }
        .formStyle(.grouped)
    }

    @ViewBuilder
    private func countedSection(_ snapshot: ReceivingSnapshot) -> some View {
        ForEach(model.stockedMatches) { match in
            Section {
                VStack(alignment: .leading, spacing: FieldGuideTokens.Space.xs) {
                    Text(match.noticeTitle).font(.subheadline.weight(.semibold))
                    Text(
                        "\(match.stockOnHand) on hand" + (match.evidence.map { " · \($0)" } ?? "")
                    )
                    .font(.caption)
                    ForEach(match.warnings, id: \.self) { Text($0).font(.caption).foregroundStyle(.orange) }
                    // There is no native Product match review yet; the candidate is read-only here.
                    Link(
                        "Review this match on web",
                        destination: appModel.webURL(for: .product, id: match.candidateID.rawValue)
                    )
                    .font(.caption)
                }
            }
        }
        Section {
            if !snapshot.stock.isEmpty {
                Text(
                    "\(snapshot.productName) already has \(model.ownUnits.formatted()) on hand ("
                        + snapshot.stock.map { "\($0.value.formatted()) \($0.unit) at \($0.locationName)" }
                        .joined(separator: ", ") + "). Importing this purchase did not change it."
                )
                .font(.callout)
            }
            if model.decision == .nothingNew {
                Button("Nothing new arrived") { dismiss() }
                    .accessibilityIdentifier("receive.nothing")
                Button("Additional units arrived") { model.chooseAdditionalUnits() }
                    .accessibilityIdentifier("receive.additional")
            } else {
                Text("Enter how many additional units arrived. Nothing is added until you do.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    private var destinationSection: some View {
        Section {
            Picker("Location", selection: $model.locationID) {
                Text("Choose a location").tag(Optional<LocationCode>.none)
                ForEach(model.locations) { location in
                    Text(location.path.map { "\(location.name) · \($0)" } ?? location.name)
                        .tag(Optional(location.id))
                }
            }
            .accessibilityIdentifier("receive.location")
            switch model.plan {
            case .move:
                Text("This is a one-of-a-kind item that is already stocked, so receiving it moves it.")
                    .font(.caption).foregroundStyle(.secondary)
            case .add(_, let unit):
                quantityRow(unit: unit, editableUnit: false)
                Text("Already stocked here. Receiving adds to that count.")
                    .font(.caption).foregroundStyle(.secondary)
            case .create:
                quantityRow(unit: model.unit, editableUnit: true)
            }
        }
    }

    @ViewBuilder
    private func quantityRow(unit: String, editableUnit: Bool) -> some View {
        HStack {
            TextField("Quantity", text: $model.quantityText)
                #if os(iOS)
                    .keyboardType(.decimalPad)
                #endif
                .accessibilityIdentifier("receive.quantity")
            if editableUnit {
                TextField("Unit", text: $model.unit).frame(maxWidth: 90)
                    .accessibilityIdentifier("receive.unit")
            } else {
                Text(unit).foregroundStyle(.secondary)
            }
        }
    }
}

#if DEBUG
    private struct PreviewReceivingService: ReceivingService {
        func receivingSnapshot(productID: ProductCode) async throws -> ReceivingSnapshot {
            ReceivingSnapshot(
                productID: productID, productName: "Sample flour",
                stock: [
                    ReceivingStock(
                        id: InventoryEntryCode("INV-2345"), locationID: LocationCode("LOC-2345"),
                        locationName: "Pantry", value: 2, unit: "each")
                ],
                matches: [
                    ReceivingMatch(
                        candidateID: ProductCode("PRD-3456"), candidateName: "Flour 5 lb", stockOnHand: 3,
                        evidence: "same GTIN", warnings: ["Both sides are stocked; merging sums them."])
                ],
                alreadyCounted: true, defaultQuantity: nil, defaultUnit: "each", suggestedPlan: .create,
                locationPlans: [
                    LocationCode("LOC-2345"): .add(entry: InventoryEntryCode("INV-2345"), unit: "each")
                ])
        }
        func receivingLocations() async throws -> [ReceivingLocation] {
            [ReceivingLocation(id: LocationCode("LOC-2345"), name: "Pantry", path: "Kitchen")]
        }
        func receive(
            expenseID: String, productID: ProductCode, locationID: LocationCode, action: ReceivingAction
        )
            async throws
        {}
    }

    #Preview {
        @Previewable @State var appModel = PreviewFixtures.signedInModel()
        ReceiveExpenseSheet(
            model: ReceivingModel(
                expenseID: "EXP-2345", productID: ProductCode("PRD-2345"), service: PreviewReceivingService())
        )
        .environment(appModel)
    }
#endif
