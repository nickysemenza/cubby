import CubbyKit
import SwiftUI

extension ExpenseSplitSession: Identifiable {
    public nonisolated var id: ObjectIdentifier { ObjectIdentifier(self) }
}
extension PurchaseExpenseLinkSession: Identifiable {
    public nonisolated var id: ObjectIdentifier { ObjectIdentifier(self) }
}
extension PurchaseProductLinkSession: Identifiable {
    public nonisolated var id: ObjectIdentifier { ObjectIdentifier(self) }
}

/// Settles a burst of keystrokes before asking the server again; a cancelled wait never asks.
private func settle() async -> Bool {
    try? await Task.sleep(for: .milliseconds(250))
    return !Task.isCancelled
}

// MARK: - Split

/// "Split" for one Expense. The starting parts, the wording, the confirmation and whether the
/// typed parts can be saved are the server's; this view only holds what is typed. Saving asks
/// for an explicit confirmation that the original expense is replaced.
struct SplitExpenseSheet: View {
    let session: ExpenseSplitSession
    /// The Purchase the parts are filed under; the original expense is gone once saved.
    let onSaved: () -> Void

    @Environment(\.dismiss) private var dismiss
    @Environment(AppModel.self) private var appModel
    @State private var confirming = false
    @State private var saveError: String?
    @State private var pickingProjectFor: UUID?

    private var expense: EntityDescriptor { EntityCatalog[.expense] }
    private var costTypes: [LabeledOption] { expense.field("costType")?.valueOptions ?? [] }
    private var trades: [LabeledOption] { expense.field("trade")?.valueOptions ?? [] }

    var body: some View {
        NavigationStack {
            Form {
                switch session.state {
                case .loading:
                    LoadingIndicator(label: "Preparing the split")
                case .failed(let message):
                    InlineLoadFailure(message: message) { await session.load() }
                case .loaded(let start):
                    Section { Text(start.description).font(.caption).foregroundStyle(.secondary) }
                    ForEach(Array(session.parts.enumerated()), id: \.element.id) { index, part in
                        partSection(part, number: index + 1, start: start)
                    }
                    totals(start)
                }
            }
            .formStyle(.grouped)
            .navigationTitle(session.start?.title ?? "Split")
            #if os(iOS)
                .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Split into \(session.parts.count)") { confirming = true }
                        .disabled(!session.canSave)
                        .accessibilityIdentifier("split.save")
                }
            }
            .confirmationDialog(
                "Split this expense?", isPresented: $confirming, titleVisibility: .visible
            ) {
                Button("Split", role: .destructive) { Task { await save() } }
            } message: {
                Text(session.confirmation ?? "")
            }
            .sheet(
                isPresented: Binding(
                    get: { pickingProjectFor != nil }, set: { if !$0 { pickingProjectFor = nil } })
            ) {
                EntityPickerSheet(target: .project) { picks in
                    if let part = pickingProjectFor {
                        session.update(part) { $0.projectID = picks.first?.id ?? "" }
                    }
                    pickingProjectFor = nil
                }
                .environment(appModel)
            }
            .task { await session.load() }
            .task(id: recheckKey) {
                guard session.start != nil, await settle() else { return }
                await session.recheck()
            }
        }
    }

    /// Changes whenever any typed part or the attribution choice changes.
    private var recheckKey: String {
        (session.parts.map {
            "\($0.name)|\($0.cost)|\($0.costType)|\($0.trade ?? "")|\($0.projectID)|\($0.keepProduct)|\($0.productQuantity)"
        }
            + [session.attributionPolicy ?? ""]).joined(separator: ";")
    }

    @ViewBuilder
    private func partSection(
        _ part: ExpenseSplitSession.Part, number: Int, start: PurchaseSplitStartOut
    ) -> some View {
        Section("Part \(number)") {
            TextField(
                "What this part is",
                text: Binding(
                    get: { part.name }, set: { value in session.update(part.id) { $0.name = value } })
            )
            .accessibilityIdentifier("split.part.\(number).name")
            TextField(
                "0.00",
                text: Binding(
                    get: { part.cost }, set: { value in session.update(part.id) { $0.cost = value } })
            )
            #if os(iOS)
                .keyboardType(.numbersAndPunctuation)
            #endif
            .accessibilityLabel("Part \(number) cost")
            .accessibilityIdentifier("split.part.\(number).cost")
            Picker(
                "Cost type",
                selection: Binding(
                    get: { part.costType }, set: { value in session.update(part.id) { $0.costType = value } })
            ) {
                ForEach(costTypes, id: \.value) { Text($0.label).tag($0.value) }
            }
            Picker(
                "Trade",
                selection: Binding(
                    get: { part.trade }, set: { value in session.update(part.id) { $0.trade = value } })
            ) {
                Text("Inherited trade").tag(String?.none)
                ForEach(trades, id: \.value) { Text($0.label).tag(String?.some($0.value)) }
            }
            HStack {
                Text("Project")
                Spacer()
                Button(part.projectID.isEmpty ? "No project" : part.projectID) {
                    pickingProjectFor = part.id
                }
                .buttonStyle(.borderless)
                if !part.projectID.isEmpty {
                    Button("Clear project", systemImage: "xmark.circle.fill") {
                        session.update(part.id) { $0.projectID = "" }
                    }
                    .labelStyle(.iconOnly).buttonStyle(.borderless).foregroundStyle(.secondary)
                }
            }
            if let productNote = start.productNote {
                Toggle(
                    start.productName.map { "Give this part the \($0) link" }
                        ?? "Give this part the product link",
                    isOn: Binding(
                        get: { part.keepProduct },
                        set: { session.setProductPart(part.id, keep: $0) })
                )
                .accessibilityHint(productNote)
                if part.keepProduct {
                    TextField(
                        "Quantity (blank if unknown)",
                        text: Binding(
                            get: { part.productQuantity },
                            set: { value in session.update(part.id) { $0.productQuantity = value } })
                    )
                    #if os(iOS)
                        .keyboardType(.numbersAndPunctuation)
                    #endif
                }
            }
            if session.parts.count > 2 {
                Button("Remove part \(number)", role: .destructive) { session.removePart(part.id) }
            }
        }
    }

    @ViewBuilder
    private func totals(_ start: PurchaseSplitStartOut) -> some View {
        Section {
            Button("Add part", systemImage: "plus") { session.addPart() }
                .disabled(!session.canAddPart)
            if !session.canAddPart {
                Text("A split can contain at most \(start.maxParts) parts.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            if let note = start.productNote {
                Text(note).font(.caption).foregroundStyle(.secondary)
            }
        }
        if session.check?.needsAttributionPolicy == true {
            Section("Household attribution") {
                Picker(
                    "Attribution",
                    selection: Binding(
                        get: { session.attributionPolicy }, set: { session.attributionPolicy = $0 })
                ) {
                    Text("Choose…").tag(String?.none)
                    Text("Parts inherit it").tag(String?.some("inherit"))
                    Text("Clear it").tag(String?.some("clear"))
                }
                .accessibilityIdentifier("split.attribution")
            }
        }
        Section {
            if let check = session.check {
                LabeledContent("Parts total", value: DisplayFormat.currency(check.partsTotal))
                LabeledContent(
                    "Original cost",
                    value: start.originalCost.map(DisplayFormat.currency) ?? "—")
                Text(check.note).font(.caption)
                    .foregroundStyle(check.delta.map { $0 != 0 } == true ? Color.orange : Color.secondary)
                if let reason = check.reason {
                    Text(reason).font(.caption).foregroundStyle(.secondary)
                        .accessibilityIdentifier("split.reason")
                }
            }
            if let saveError {
                Text(saveError).font(.caption).foregroundStyle(FieldGuideTokens.destructive)
            }
        }
    }

    private func save() async {
        saveError = nil
        do {
            _ = try await session.save(confirmed: true)
            onSaved()
            dismiss()
        } catch let error as ExpenseSplitSession.Failure {
            switch error {
            case .refused(let reason): saveError = reason
            case .needsConfirmation(let text): saveError = text
            case .notLoaded: saveError = "The split is still loading."
            }
        } catch {
            Diagnostics.report(error, context: "Split expense")
            saveError = error.userMessage
            appModel.handle(error)
        }
    }
}

// MARK: - Attach expenses

/// "Attach existing expenses" to one Purchase. Candidates, wording, the total the selection
/// leads to and the warning about expenses that would move are the server's. Moving expenses off
/// another purchase asks for an explicit confirmation first.
struct LinkExpensesSheet: View {
    let session: PurchaseExpenseLinkSession
    let onSaved: () -> Void

    @Environment(\.dismiss) private var dismiss
    @Environment(AppModel.self) private var appModel
    @State private var searchText = ""
    @State private var confirmation: String?
    @State private var saveError: String?

    var body: some View {
        NavigationStack {
            List {
                if let candidates = session.candidates {
                    Section {
                        Picker(
                            "Scope",
                            selection: Binding(
                                get: { session.scope },
                                set: { value in Task { await session.setScope(value) } })
                        ) {
                            ForEach(candidates.scopes, id: \.value) { scope in
                                Text(scope.label).tag(scope.value.rawValue)
                            }
                        }
                        .accessibilityIdentifier("attach.expenses.scope")
                    }
                    if let message = candidates.message {
                        Text(message).foregroundStyle(.secondary)
                    }
                    ForEach(candidates.candidates) { candidate in
                        row(candidate)
                    }
                    Section { Text(candidates.caution).font(.caption).foregroundStyle(.secondary) }
                } else if case .failed(let message) = session.state {
                    InlineLoadFailure(message: message) { await session.load() }
                } else {
                    LoadingIndicator(label: "Finding expenses")
                }
                summary
            }
            .searchable(text: $searchText, prompt: "Search expense names")
            .navigationTitle("Attach expenses")
            #if os(iOS)
                .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Attach \(session.selection.count)") { Task { await attach(confirmed: false) } }
                        .disabled(!session.canAttach)
                        .accessibilityIdentifier("attach.expenses.save")
                }
            }
            .confirmationDialog(
                "Move expenses to this purchase?",
                isPresented: Binding(get: { confirmation != nil }, set: { if !$0 { confirmation = nil } }),
                titleVisibility: .visible
            ) {
                Button("Attach") { Task { await attach(confirmed: true) } }
            } message: {
                Text(confirmation ?? "")
            }
            .task { await session.load() }
            .task(id: searchText) {
                guard searchText != session.search, await settle() else { return }
                await session.setSearch(searchText)
            }
            .task(id: session.selection) {
                guard await settle() else { return }
                await session.recheck()
            }
        }
    }

    private func row(_ candidate: PurchaseLinkExpenseCandidate) -> some View {
        Button {
            session.toggle(candidate.id)
        } label: {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(candidate.name)
                    Text(candidate.summary).font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                if let cost = candidate.cost { Text(DisplayFormat.currency(cost)).monospacedDigit() }
                Image(systemName: session.isSelected(candidate.id) ? "checkmark.circle.fill" : "circle")
            }
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("attach.expenses.candidate.\(candidate.id)")
        .accessibilityAddTraits(session.isSelected(candidate.id) ? .isSelected : [])
    }

    @ViewBuilder private var summary: some View {
        if !session.selection.isEmpty {
            Section {
                if let note = session.check?.note { Text(note).font(.caption) }
                if let reason = session.check?.reason {
                    Text(reason).font(.caption).foregroundStyle(.secondary)
                }
                if let saveError {
                    Text(saveError).font(.caption).foregroundStyle(FieldGuideTokens.destructive)
                }
            }
        }
    }

    private func attach(confirmed: Bool) async {
        saveError = nil
        do {
            try await session.attach(confirmed: confirmed)
            onSaved()
            dismiss()
        } catch let error as PurchaseExpenseLinkSession.Failure {
            switch error {
            case .needsConfirmation(let text): confirmation = text
            case .refused(let reason): saveError = reason
            case .nothingSelected: saveError = "Select at least one expense."
            }
        } catch {
            Diagnostics.report(error, context: "Attach expenses")
            saveError = error.userMessage
            appModel.handle(error)
        }
    }
}

// MARK: - Attach products

/// "Attach products" to one Purchase: record which products an order bought. It carries no money
/// or quantity, so it changes no spend and no inventory.
struct LinkProductsSheet: View {
    let session: PurchaseProductLinkSession
    let onSaved: () -> Void

    @Environment(\.dismiss) private var dismiss
    @Environment(AppModel.self) private var appModel
    @State private var searchText = ""
    @State private var saveError: String?

    var body: some View {
        NavigationStack {
            List {
                if let candidates = session.candidates {
                    Section { Text(candidates.note).font(.caption).foregroundStyle(.secondary) }
                    if let message = candidates.message {
                        Text(message).foregroundStyle(.secondary)
                    }
                    ForEach(candidates.candidates) { candidate in
                        Button {
                            session.toggle(candidate.id.rawValue)
                        } label: {
                            HStack(alignment: .top) {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(candidate.name)
                                    Text(candidate.manufacturer).font(.caption).foregroundStyle(.secondary)
                                }
                                Spacer()
                                if let price = candidate.price {
                                    Text(DisplayFormat.currency(price)).monospacedDigit()
                                }
                                Image(
                                    systemName: session.isSelected(candidate.id.rawValue)
                                        ? "checkmark.circle.fill" : "circle")
                            }
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("attach.products.candidate.\(candidate.id.rawValue)")
                        .accessibilityAddTraits(session.isSelected(candidate.id.rawValue) ? .isSelected : [])
                    }
                } else if case .failed(let message) = session.state {
                    InlineLoadFailure(message: message) { await session.load() }
                } else {
                    LoadingIndicator(label: "Finding products")
                }
                if let saveError {
                    Text(saveError).font(.caption).foregroundStyle(FieldGuideTokens.destructive)
                }
            }
            .searchable(text: $searchText, prompt: "Search products")
            .navigationTitle("Attach products")
            #if os(iOS)
                .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Attach \(session.selection.count)") { Task { await attach() } }
                        .disabled(!session.canAttach)
                        .accessibilityIdentifier("attach.products.save")
                }
            }
            .task { await session.load() }
            .task(id: searchText) {
                guard searchText != session.search, await settle() else { return }
                await session.setSearch(searchText)
            }
        }
    }

    private func attach() async {
        saveError = nil
        do {
            try await session.attach()
            onSaved()
            dismiss()
        } catch {
            Diagnostics.report(error, context: "Attach products")
            saveError = error.userMessage
            appModel.handle(error)
        }
    }
}
