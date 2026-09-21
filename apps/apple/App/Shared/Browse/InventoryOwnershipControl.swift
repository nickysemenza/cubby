import CubbyKit
import SwiftUI

/// The compact inventory-detail affordance for ownership. The generic editor still owns the full
/// record form; this control exposes the evidence-aware confirm and inherit operations, including
/// their row-splitting quantity option.
struct InventoryOwnershipControl: View {
    private let detail: InventoryDetail?
    private let onChanged: () -> Void

    @Environment(AppModel.self) private var appModel
    @State private var model: InventoryOwnershipModel
    @State private var editing = false
    @State private var pickingOwner = false

    init(detail: InventoryDetail, onChanged: @escaping () -> Void) {
        self.detail = detail
        self.onChanged = onChanged
        _model = State(initialValue: .init(detail: detail))  // state-init-ok: synced by onChange.
    }

    fileprivate init(previewModel: InventoryOwnershipModel) {
        detail = nil
        onChanged = {}
        _model = State(initialValue: previewModel)  // state-init-ok: preview-only fixture model.
    }

    var body: some View {
        VStack(alignment: .leading, spacing: PorcelainTokens.Space.sm) {
            HStack(spacing: PorcelainTokens.Space.sm) {
                Label(model.summary, systemImage: "person.crop.circle")
                    .font(.porcelainLabel)
                    .foregroundStyle(PorcelainTokens.graphiteSecondary)
                if model.confirmedMatchesInheritedOwner {
                    StatusChip(text: "Confirmed matches inherited owner", tone: .positive)
                }
            }
            Button("Manage ownership") { editing = true }
                .buttonStyle(.bordered)
                .accessibilityIdentifier("detail.inventory.ownership.manage")
        }
        .sheet(isPresented: $editing) { editor }
        .onChange(of: detail) { _, updated in
            if let updated { model.apply(updated) }
        }
    }

    private var editor: some View {
        @Bindable var model = model
        return NavigationStack {
            Form {
                Section("Current ownership") {
                    LabeledContent("Stored choice", value: model.currentModeLabel)
                    LabeledContent("Explicit owner", value: model.currentExplicitOwnerLabel)
                    LabeledContent("Effective owner", value: model.currentEffectiveOwnerLabel)
                    LabeledContent("Source", value: model.currentSourceLabel)
                    if model.confirmedMatchesInheritedOwner {
                        Label("Confirmed matches inherited owner", systemImage: "checkmark.seal.fill")
                            .foregroundStyle(PorcelainTokens.positive)
                    }
                }

                Section("Change ownership") {
                    Picker("Stored choice", selection: $model.selectionMode) {
                        Text("Use inherited owner").tag(InventoryOwnershipMode.inherit)
                        Text("Person").tag(InventoryOwnershipMode.person)
                        Text("No individual owner").tag(InventoryOwnershipMode.unassigned)
                    }
                    if model.selectionMode == .person {
                        Button {
                            pickingOwner = true
                        } label: {
                            LabeledContent("Person", value: model.selectedOwnerLabel)
                                .frame(minHeight: PorcelainTokens.touchTarget)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                }

                Section {
                    Toggle("Apply to part of this quantity", isOn: $model.appliesToPartialQuantity)
                    if model.appliesToPartialQuantity {
                        HStack(spacing: PorcelainTokens.Space.sm) {
                            TextField("Quantity", text: $model.quantityText)
                                .keyboardDismissBar()
                                #if os(iOS)
                                    .keyboardType(.decimalPad)
                                #endif
                                .font(.porcelainData)
                                .accessibilityIdentifier("detail.inventory.ownership.quantity")
                            Text(model.unit)
                                .font(.porcelainLabel)
                                .foregroundStyle(PorcelainTokens.graphiteSecondary)
                        }
                    }
                } header: {
                    Text("Quantity")
                } footer: {
                    if let quantityMessage = model.quantityMessage {
                        Text(quantityMessage)
                            .foregroundStyle(
                                model.hasValidQuantity
                                    ? PorcelainTokens.graphiteSecondary : PorcelainTokens.destructive)
                    }
                }

                if model.canConfirmInheritedOwner {
                    Section {
                        Button {
                            Task { await perform(.confirm) }
                        } label: {
                            Label(
                                "Confirm \(model.currentEffectiveOwnerLabel)",
                                systemImage: "checkmark.seal")
                        }
                        .disabled(!model.canSubmit || model.isSaving)
                        .accessibilityIdentifier("detail.inventory.ownership.confirm")
                    } footer: {
                        Text(
                            "Pins the inherited owner you reviewed, even if its acquisition source changes later."
                        )
                    }
                }

                if model.currentMode != .inherit {
                    Section {
                        Button {
                            Task { await perform(.inheritOwner) }
                        } label: {
                            Label("Use inherited owner", systemImage: "arrow.uturn.backward")
                        }
                        .disabled(!model.canSubmit || model.isSaving)
                        .accessibilityIdentifier("detail.inventory.ownership.inherit")
                    }
                }

                if let error = model.errorMessage {
                    Section {
                        Label(error, systemImage: "exclamationmark.triangle")
                            .foregroundStyle(PorcelainTokens.destructive)
                    }
                }
            }
            .navigationTitle("Ownership")
            #if os(iOS)
                .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { editing = false }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(model.isSaving ? "Saving…" : "Save") {
                        Task { await perform(.saveSelection) }
                    }
                    .disabled(!model.canSaveSelection || model.isSaving)
                    .accessibilityIdentifier("detail.inventory.ownership.save")
                }
            }
            .sheet(isPresented: $pickingOwner) {
                EntityPickerSheet(
                    target: .ledgerParty,
                    selected: [model.selectedOwnerID].compactMap { $0 },
                    scope: Self.ownerPickerScope
                ) { picks in
                    guard let owner = picks.first else { return }
                    model.selectOwner(id: owner.id, name: owner.title)
                }
            }
        }
        .nativeSheet(.editor)
    }

    private func perform(_ action: InventoryOwnershipModel.Action) async {
        guard await model.perform(action, client: appModel.client) else { return }
        appModel.recordEntityMutation(keys: [.inventory, .product, .location, .ledgerParty])
        editing = false
        onChanged()
    }

    /// The inventory manifest is the authority for eligible owner kinds. This keeps the detail
    /// control aligned with the full generic form instead of duplicating member/guest policy.
    private static var ownerPickerScope: EntityPickerScope? {
        guard let ownerField = EntityCatalog[.inventory].field("ownerLedgerPartyId") else { return nil }
        return EntityReferenceScope.pickerScope(field: ownerField, draft: [:])
    }
}

@MainActor @Observable
final class InventoryOwnershipModel {
    enum Action { case saveSelection, confirm, inheritOwner }

    private(set) var inventoryID: InventoryEntryCode
    private(set) var currentMode: InventoryOwnershipMode
    private(set) var currentExplicitOwnerID: LedgerPartyShortcode?
    private(set) var currentExplicitOwnerName: String?
    private(set) var currentEffectiveOwner: InventoryOwner?
    private(set) var currentSource: InventoryOwnershipSource
    private(set) var evidenceFingerprint: String
    private(set) var confirmedMatchesInheritedOwner: Bool
    private(set) var amount: Double
    private(set) var unit: String

    var selectionMode: InventoryOwnershipMode
    var selectedOwnerID: LedgerPartyShortcode?
    var selectedOwnerName: String?
    var appliesToPartialQuantity = false
    var quantityText = ""
    private(set) var isSaving = false
    private(set) var errorMessage: String?

    init(detail: InventoryDetail) {
        inventoryID = detail.id
        currentMode = detail.ownershipMode
        currentExplicitOwnerID = detail.ownerLedgerPartyId
        currentExplicitOwnerName = detail.effectiveOwnership.explicitOwner?.name
        currentEffectiveOwner = detail.effectiveOwnership.effectiveOwner
        currentSource = detail.effectiveOwnership.source
        evidenceFingerprint = detail.effectiveOwnership.evidenceFingerprint
        confirmedMatchesInheritedOwner = detail.effectiveOwnership.matchesInheritedOwner
        amount = detail.amount.value
        unit = detail.amount.unit
        selectionMode = detail.ownershipMode
        selectedOwnerID = detail.ownerLedgerPartyId
        selectedOwnerName = detail.effectiveOwnership.explicitOwner?.name
    }

    init(
        inventoryID: InventoryEntryCode, amount: Double, unit: String,
        mode: InventoryOwnershipMode, explicitOwner: InventoryOwner?,
        effectiveOwner: InventoryOwner?, source: InventoryOwnershipSource,
        evidenceFingerprint: String, matchesInheritedOwner: Bool
    ) {
        self.inventoryID = inventoryID
        self.amount = amount
        self.unit = unit
        currentMode = mode
        currentExplicitOwnerID = explicitOwner?.id
        currentExplicitOwnerName = explicitOwner?.name
        currentEffectiveOwner = effectiveOwner
        currentSource = source
        self.evidenceFingerprint = evidenceFingerprint
        confirmedMatchesInheritedOwner = matchesInheritedOwner
        selectionMode = mode
        selectedOwnerID = explicitOwner?.id
        selectedOwnerName = explicitOwner?.name
    }

    var summary: String {
        switch currentMode {
        case .person: currentExplicitOwnerLabel
        case .inherit: currentEffectiveOwner.map { "Inherited: \($0.name)" } ?? "Inherited owner unresolved"
        case .unassigned: "No individual owner"
        }
    }

    var currentModeLabel: String {
        switch currentMode {
        case .inherit: "Use inherited owner"
        case .person: "Person"
        case .unassigned: "No individual owner"
        }
    }

    var currentExplicitOwnerLabel: String {
        currentExplicitOwnerName ?? currentExplicitOwnerID ?? "None"
    }

    var currentEffectiveOwnerLabel: String { currentEffectiveOwner?.name ?? "Unresolved" }

    var currentSourceLabel: String {
        switch currentSource {
        case .explicit: "Explicit choice"
        case .unassigned: "No individual owner"
        case .inheritedBeneficiary: "Purchase beneficiary"
        case .inheritedVendorAccount: "Vendor account default"
        case .inheritedPaymentAccount: "Payment account default"
        case .unresolved: "Unresolved"
        }
    }

    var selectedOwnerLabel: String { selectedOwnerName ?? selectedOwnerID ?? "Choose a person" }

    var canConfirmInheritedOwner: Bool {
        currentMode == .inherit && currentEffectiveOwner != nil && !evidenceFingerprint.isEmpty
    }

    var partialQuantity: Double? {
        guard appliesToPartialQuantity else { return nil }
        return AdjustmentQuantityDraft(text: quantityText).value
    }

    var hasValidQuantity: Bool {
        !appliesToPartialQuantity || partialQuantity.map { $0 <= amount } == true
    }

    var quantityMessage: String? {
        guard appliesToPartialQuantity else { return "Changes the entire \(formatted(amount)) \(unit) row." }
        guard let partialQuantity else { return "Enter an amount greater than zero." }
        guard partialQuantity <= amount else {
            return "Enter no more than \(formatted(amount)) \(unit)."
        }
        return "The remaining \(formatted(amount - partialQuantity)) \(unit) keeps its current ownership."
    }

    var canSubmit: Bool { hasValidQuantity }

    var canSaveSelection: Bool {
        canSubmit && (selectionMode != .person || selectedOwnerID != nil)
    }

    func apply(_ detail: InventoryDetail) {
        inventoryID = detail.id
        currentMode = detail.ownershipMode
        currentExplicitOwnerID = detail.ownerLedgerPartyId
        currentExplicitOwnerName = detail.effectiveOwnership.explicitOwner?.name
        currentEffectiveOwner = detail.effectiveOwnership.effectiveOwner
        currentSource = detail.effectiveOwnership.source
        evidenceFingerprint = detail.effectiveOwnership.evidenceFingerprint
        confirmedMatchesInheritedOwner = detail.effectiveOwnership.matchesInheritedOwner
        amount = detail.amount.value
        unit = detail.amount.unit
        selectionMode = detail.ownershipMode
        selectedOwnerID = detail.ownerLedgerPartyId
        selectedOwnerName = detail.effectiveOwnership.explicitOwner?.name
        appliesToPartialQuantity = false
        quantityText = ""
        errorMessage = nil
    }

    func selectOwner(id: LedgerPartyShortcode, name: String) {
        selectedOwnerID = id
        selectedOwnerName = name
    }

    func perform(_ action: Action, client: CubbyClient) async -> Bool {
        guard canSubmit else { return false }
        isSaving = true
        errorMessage = nil
        defer { isSaving = false }
        do {
            switch action {
            case .confirm:
                guard canConfirmInheritedOwner else { return false }
                _ = try await client.confirmInventoryOwnership(
                    .init(
                        inventoryEntryId: inventoryID,
                        evidenceFingerprint: evidenceFingerprint,
                        quantity: partialQuantity
                    ))
            case .inheritOwner:
                _ = try await client.setInventoryOwnership(
                    .init(
                        inventoryEntryId: inventoryID,
                        ownership: .inherit(.init(mode: .inherit)),
                        quantity: partialQuantity
                    ))
            case .saveSelection:
                guard let ownership = selectedOwnership else { return false }
                _ = try await client.setInventoryOwnership(
                    .init(
                        inventoryEntryId: inventoryID,
                        ownership: ownership,
                        quantity: partialQuantity
                    ))
            }
            return true
        } catch {
            errorMessage = (error as? CubbyAPIError)?.detail?.message ?? String(describing: error)
            Diagnostics.report(error, context: "inventory.ownership")
            return false
        }
    }

    private var selectedOwnership: InventoryOwnershipSelection? {
        switch selectionMode {
        case .inherit:
            .inherit(.init(mode: .inherit))
        case .person:
            selectedOwnerID.map { .person(.init(mode: .person, ownerId: $0)) }
        case .unassigned:
            .unassigned(.init(mode: .unassigned))
        }
    }

    private func formatted(_ value: Double) -> String {
        value.formatted(.number.precision(.fractionLength(0...3)))
    }
}

#Preview("Inventory ownership") {
    let owner = InventoryOwner(id: "LPY-1234", name: "Alex", kind: .member)
    let model = InventoryOwnershipModel(
        inventoryID: InventoryEntryCode("INV-1234"), amount: 3, unit: "each",
        mode: .inherit, explicitOwner: nil, effectiveOwner: owner,
        source: .inheritedBeneficiary, evidenceFingerprint: "preview-evidence",
        matchesInheritedOwner: false
    )
    InventoryOwnershipControl(previewModel: model)
        .padding(PorcelainTokens.Space.lg)
        .background(PorcelainTokens.canvas)
        .environment(PreviewFixtures.signedInModel())
}
