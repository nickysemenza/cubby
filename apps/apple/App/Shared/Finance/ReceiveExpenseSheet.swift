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
        (lines ?? []).filter { $0.raw.recordValue("productId")?.stringValue != nil }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: FieldGuideTokens.Space.sm) {
            if let error {
                InlineLoadFailure(message: error) { await load() }
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
                        if let productID = line.raw.recordValue("productId")?.stringValue {
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
                filters: EntityFilterState([EntityFilterParameter.Expense.purchaseIdFilter: [purchaseID]]))
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
                    LoadFailureView(title: "Could not load stock", message: message) { await model.load() }
                case .loaded:
                    form
                }
            }
            // A short title so the product name, which leads the form, never truncates it.
            .navigationTitle("Receive Stock")
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

    /// Reading order: the product and its current stock, the arrival decision, then the place and
    /// amount with the write it will make. Possible duplicate records follow, warnings visible.
    private var form: some View {
        Form {
            if let snapshot = model.snapshot {
                arrivalSection(snapshot)
            }
            if model.decision == .additionalUnits {
                destinationSection
            }
            if let refusal = model.refusal {
                Section {
                    Text(refusal).foregroundStyle(FieldGuideTokens.destructive).textSelection(.enabled)
                        .accessibilityIdentifier("receive.refusal")
                }
            }
            if model.alreadyCounted {
                matchesSection
            }
        }
        .formStyle(.grouped)
    }

    @ViewBuilder
    private func arrivalSection(_ snapshot: ReceivingSnapshot) -> some View {
        Section {
            LabeledContent(snapshot.productName) {
                Text(snapshot.stock.isEmpty ? "Not stocked" : "\(ValueFormat.count(model.ownUnits)) on hand")
            }
            ForEach(snapshot.stock) { stock in
                LabeledContent(
                    stock.locationName, value: ValueFormat.amount(unit: stock.unit, value: stock.value)
                )
                .foregroundStyle(.secondary)
            }
            if model.decision == .nothingNew {
                Button("No additional units") { dismiss() }
                    .accessibilityIdentifier("receive.nothing")
                Button("Additional units arrived") { model.chooseAdditionalUnits() }
                    .accessibilityIdentifier("receive.additional")
            }
        } header: {
            Text("What arrived?")
        } footer: {
            if model.alreadyCounted {
                Text(
                    "Importing this purchase did not change stock. Receive only units that actually arrived.")
            }
        }
    }

    @ViewBuilder
    private var matchesSection: some View {
        if !model.stockedMatches.isEmpty {
            Section("Possibly already counted") {
                ForEach(model.stockedMatches) { match in
                    VStack(alignment: .leading, spacing: FieldGuideTokens.Space.xs) {
                        Text(match.noticeTitle).font(.subheadline.weight(.semibold))
                        Text(
                            "\(match.stockOnHand) on hand" + (match.evidence.map { " · \($0)" } ?? "")
                        )
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        ForEach(match.warnings, id: \.self) {
                            Label($0, systemImage: "exclamationmark.triangle")
                                .font(.caption).foregroundStyle(FieldGuideTokens.warning)
                        }
                        // There is no native Product match review yet; the candidate is read-only here.
                        OpenOnWebButton(
                            target: .record(key: .product, id: match.candidateID.rawValue),
                            label: "Review this match on web"
                        )
                        .font(.caption)
                    }
                }
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
                EmptyView()
            case .add(_, let unit):
                quantityRow(unit: unit, editableUnit: false)
            case .create:
                quantityRow(unit: model.unit, editableUnit: true)
            }
        } header: {
            Text("Additional units")
        } footer: {
            Text(consequence).accessibilityIdentifier("receive.consequence")
        }
    }

    /// The write Receive will make, worded from the model's plan; the server still validates it.
    private var consequence: String {
        let place = model.locations.first { $0.id == model.locationID }?.name
        switch model.plan {
        case .move(_, let from):
            guard let place else {
                return "This one-of-a-kind item is already stocked, so receiving moves it. Choose where."
            }
            return from == model.locationID
                ? "This item is already at \(place). Choose a different location to move it."
                : "Moves this one-of-a-kind item to \(place)."
        case .add(_, let unit):
            guard let place else { return "Choose a location." }
            guard let quantity = model.quantity else { return "Enter how many arrived to add to \(place)." }
            return "Adds \(ValueFormat.amount(unit: unit, value: quantity)) to the stock already at \(place)."
        case .create:
            guard let place else { return "Choose a location." }
            guard let quantity = model.quantity else { return "Enter how many arrived." }
            return "Stocks \(ValueFormat.amount(unit: model.unit, value: quantity)) at \(place)."
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
