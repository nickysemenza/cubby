import CubbyKit
import SwiftUI

extension StatementMatchSession: Identifiable {
    public nonisolated var id: ObjectIdentifier { ObjectIdentifier(self) }
}

/// "Match statement activity": review the unallocated statement entries near an order and
/// allocate one across Purchases. The list, its wording, the tie that offers "Suggest a match",
/// the starting rows and whether the typed rows can be saved are the server's; a suggestion
/// orders and badges the tied entries and never picks one. Saving is an explicit tap.
struct StatementMatchSheet: View {
    let session: StatementMatchSession
    let onSaved: () -> Void

    @Environment(AppModel.self) private var appModel
    @Environment(\.dismiss) private var dismiss
    @State private var saveError: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text(
                        "Review unallocated charges and refunds near this order. Allocate the full statement amount across Purchases before saving."
                    )
                    .font(.caption).foregroundStyle(.secondary)
                }
                candidates
                if session.selectedTransactionID != nil { allocation }
            }
            .formStyle(.grouped)
            .navigationTitle("Match statement activity")
            #if os(iOS)
                .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save allocation") { Task { await save() } }
                        .disabled(!session.canSave)
                        .accessibilityIdentifier("statement.match.save")
                }
            }
            .task { await session.load() }
            .task(id: recheckKey) {
                guard session.selectedTransactionID != nil else { return }
                // Let a burst of keystrokes settle; a cancelled wait never asks.
                try? await Task.sleep(for: .milliseconds(250))
                guard !Task.isCancelled else { return }
                await session.recheck()
            }
        }
    }

    /// Changes whenever the chosen entry or any typed row changes.
    private var recheckKey: String {
        ([session.selectedTransactionID ?? ""] + session.rows.map { "\($0.purchaseID)|\($0.amount)" })
            .joined(separator: ";")
    }

    @ViewBuilder private var candidates: some View {
        Section("Statement activity") {
            switch session.state {
            case .loading:
                LoadingIndicator(label: "Checking statement activity")
            case .failed(let message):
                InlineLoadFailure(message: message) { await session.load() }
            case .loaded(let review):
                if let message = review.message { Text(message).foregroundStyle(.secondary) }
                if review.suggestHint != nil {
                    Button(session.isSuggesting ? "Asking Jev…" : "Suggest a match") {
                        Task { await session.suggest() }
                    }
                    .disabled(session.isSuggesting)
                    .accessibilityIdentifier("statement.match.suggest")
                }
                if let note = session.suggestionNote {
                    Text(note).font(.caption).foregroundStyle(.secondary)
                }
                ForEach(session.displayOrder, id: \.self) { id in
                    if let candidate = review.candidates.first(where: { $0.transaction.id == id }) {
                        CandidateRow(
                            candidate: candidate,
                            badge: session.badge(for: id),
                            isSelected: session.selectedTransactionID == id,
                            choose: { session.select(id) })
                    }
                }
            }
        }
    }

    @ViewBuilder private var allocation: some View {
        Section {
            ForEach(session.rows) { row in
                VStack(alignment: .leading, spacing: FieldGuideTokens.Space.xs) {
                    TextField(
                        "Purchase code",
                        text: Binding(
                            get: { row.purchaseID },
                            set: { session.setPurchaseID($0, for: row.id) })
                    )
                    .autocorrectionDisabled()
                    #if os(iOS)
                        .textInputAutocapitalization(.characters)
                    #endif
                    TextField(
                        "Amount",
                        text: Binding(
                            get: { row.amount },
                            set: { session.setAmount($0, for: row.id) })
                    )
                    #if os(iOS)
                        .keyboardType(.numbersAndPunctuation)
                    #endif
                }
            }
            Button("Add Purchase") { session.addRow() }
            if let reason = session.check?.reason {
                Text(reason).font(.caption).foregroundStyle(.secondary)
                    .accessibilityIdentifier("statement.match.reason")
            }
            if let saveError {
                Text(saveError).font(.caption).foregroundStyle(FieldGuideTokens.destructive)
            }
        } header: {
            Text("Allocate")
        }
    }

    private func save() async {
        saveError = nil
        do {
            try await session.save()
            onSaved()
            dismiss()
        } catch let error as StatementMatchSession.Failure {
            switch error {
            case .refused(let reason): saveError = reason
            case .nothingSelected: saveError = "Choose a statement entry first."
            }
        } catch {
            Diagnostics.report(error, context: "Save settlement allocation")
            saveError = error.userMessage
            appModel.handle(error)
        }
    }
}

private struct CandidateRow: View {
    let candidate: PurchaseSettlementCandidate
    let badge: String?
    let isSelected: Bool
    let choose: () -> Void

    var body: some View {
        Button(action: choose) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: FieldGuideTokens.Space.xs) {
                    if let badge {
                        Text(badge).font(.caption2.weight(.semibold))
                            .padding(.horizontal, 6)
                            .background(.quaternary, in: Capsule())
                    }
                    Text(candidate.title).font(.subheadline.weight(.semibold))
                    ForEach(candidate.lines, id: \.self) { line in
                        Text(line).font(.caption).foregroundStyle(.secondary)
                    }
                }
                Spacer()
                Text(DisplayFormat.currency(candidate.transaction.amount)).monospacedDigit()
                if isSelected { Image(systemName: "checkmark.circle.fill") }
            }
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("statement.match.candidate.\(candidate.transaction.id)")
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }
}
