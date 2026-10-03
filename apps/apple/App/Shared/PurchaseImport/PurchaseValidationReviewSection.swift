import CubbyKit
import SwiftUI

/// The corrections a purchase-validation run proposes for each Purchase. A person picks the ones
/// to apply; nothing changes until "Apply" and a stale selection is refused with the server's
/// raw reasons.
struct PurchaseValidationReviewSection: View {
    let runID: String
    private let isPreview: Bool

    @Environment(AppModel.self) private var appModel
    @State private var session: PurchaseValidationReviewSession?

    init(runID: String, previewSession: PurchaseValidationReviewSession? = nil) {
        self.runID = runID
        isPreview = previewSession != nil
        _session = State(initialValue: previewSession)  // state-init-ok: fixture
    }

    var body: some View {
        Group {
            if let session {
                ForEach(session.targets) { target in
                    targetSection(target, session: session)
                }
                if let error = session.error {
                    Section {
                        Text(error)
                            .font(.fieldGuideLabel)
                            .foregroundStyle(FieldGuideTokens.destructive)
                            .textSelection(.enabled)
                    }
                }
            }
        }
        .task(id: runID) {
            guard !isPreview else { return }
            let next = PurchaseValidationReviewSession(service: appModel.client)
            session = next
            await next.refresh(runID: runID)
        }
    }

    private func targetSection(
        _ target: PurchaseValidationTarget, session: PurchaseValidationReviewSession
    ) -> some View {
        Section {
            ForEach(target.corrections) { correction in
                Toggle(
                    isOn: Binding(
                        get: { session.isSelected(correction.id, purchase: target.purchaseCode) },
                        set: { _ in session.toggle(correction.id, purchase: target.purchaseCode) })
                ) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("\(correction.recordText) · \(correction.field)")
                            .font(.fieldGuideLabel)
                            .foregroundStyle(FieldGuideTokens.graphiteSecondary)
                        Text("\(correction.beforeText) → \(correction.afterText)")
                    }
                }
                #if os(macOS)
                    .toggleStyle(.checkbox)
                #endif
                .accessibilityIdentifier("validation.correction.\(correction.id)")
            }
            ForEach(target.notes) { note in
                Label {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("\(note.recordText) · \(note.field)")
                            .font(.fieldGuideLabel)
                        Text(note.message)
                    }
                    .foregroundStyle(FieldGuideTokens.graphiteSecondary)
                } icon: {
                    Image(systemName: "info.circle").foregroundStyle(FieldGuideTokens.graphiteSecondary)
                }
                .textSelection(.enabled)
            }
            if target.rawEvidenceDrift {
                Label(
                    "Evidence changed since this target was reviewed.",
                    systemImage: "exclamationmark.triangle"
                )
                .foregroundStyle(FieldGuideTokens.warning)
            }
            let selected = session.selectedIDs(for: target.purchaseCode).count
            if !target.corrections.isEmpty {
                Button(selected == 1 ? "Apply 1 correction" : "Apply \(selected) corrections") {
                    Task {
                        await session.apply(purchase: target.purchaseCode, runID: runID)
                        appModel.recordEntityMutation(keys: [.expense, .purchase, .run])
                    }
                }
                .disabled(selected == 0 || session.busy)
                .accessibilityIdentifier("validation.apply.\(target.purchaseCode)")
            }
            if let outcome = session.outcome(for: target.purchaseCode) {
                Text(outcome).foregroundStyle(FieldGuideTokens.positive)
            }
            ForEach(session.staleReasons(for: target.purchaseCode)) { stale in
                Text(stale.reason)
                    .font(.fieldGuideLabel)
                    .foregroundStyle(FieldGuideTokens.destructive)
                    .textSelection(.enabled)
            }
        } header: {
            Text(target.name ?? target.purchaseCode)
        } footer: {
            if target.corrections.isEmpty && target.notes.isEmpty {
                Text("Nothing to correct.")
            }
        }
    }
}

#if DEBUG
    private struct PreviewService: PurchaseValidationServing {
        func validationTargets(runID: String) async throws -> [PurchaseValidationTarget] {
            let diff: JSONValue = [
                "version": 2,
                "corrections": [
                    [
                        "id": "c-total", "kind": "purchase_stated_total",
                        "target": ["kind": "purchase", "code": "PUR-4K7M"],
                        "field": "statedTotal", "before": nil, "after": 12.5,
                    ],
                    [
                        "id": "c-title", "kind": "expense_field",
                        "target": ["kind": "expense", "code": "EXP-4K7M"],
                        "field": "title", "before": "Oat milk", "after": "Oat milk 1 L",
                    ],
                ],
                "notes": [
                    [
                        "id": "n-1", "target": ["kind": "expense", "code": "EXP-4K7M"],
                        "field": "productId", "before": "PRD-4K7M", "after": "PRD-8H2Q",
                        "message": "Product differs; review by hand.",
                    ]
                ],
                "rawEvidenceDrift": false,
            ]
            return [
                PurchaseValidationTarget(
                    purchaseCode: "PUR-4K7M", name: "Example grocery order", diff: diff)
            ].compactMap { $0 }
        }

        func applyValidationCorrections(_ input: ApplyValidationCorrectionsInput) async throws
            -> ApplyValidationCorrectionsOut
        {
            .stale(
                .init(
                    status: .stale, runId: input.runId, purchaseId: input.purchaseId,
                    stale: [.init(correctionId: "c-title", reason: "expense EXP-4K7M title changed")]))
        }
    }

    #Preview("Validation corrections", traits: .modifier(SignedInPreview())) {
        let session = PurchaseValidationReviewSession(service: PreviewService())
        List {
            PurchaseValidationReviewSection(runID: "RUN-4K7M", previewSession: session)
        }
        .task { await session.refresh(runID: "RUN-4K7M") }
    }
#endif
