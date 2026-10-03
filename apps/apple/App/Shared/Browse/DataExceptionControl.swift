import CubbyKit
import SwiftUI

/// Accept-or-clear action for one explained data-quality check. The reason list and its labels come
/// from the server's explanation, so a check that forbids exceptions arrives with none and shows no
/// action. Operational Problems and aggregate rules are not breakdown checks and never reach here.
struct DataExceptionControl: View {
    struct Option: Hashable {
        let reason: DataExceptionReason
        let label: String
    }

    let draft: DataExceptionDraft
    let isGap: Bool
    let options: [Option]
    /// The recorded exception, active or stale, as `(reason, note, isStale)`.
    let recorded: (reason: DataExceptionReason, note: String, isStale: Bool)?
    let onChanged: () -> Void

    @Environment(AppModel.self) private var appModel
    @State private var accepting = false
    @State private var reason: DataExceptionReason?
    @State private var note = ""
    @State private var working = false

    var body: some View {
        if let recorded {
            VStack(alignment: .leading, spacing: FieldGuideTokens.Space.xs) {
                Text(
                    "\(recorded.isStale ? "Evidence changed since this exception was recorded: " : "Recorded as ")\(label(for: recorded.reason)) — \(recorded.note)"
                )
                .font(.caption).foregroundStyle(.secondary)
                Button("Clear exception") { Task { await clear() } }
                    .buttonStyle(.bordered).disabled(working)
                    .accessibilityIdentifier("field.explanation.exception.clear.\(draft.check)")
            }
        } else if isGap, !options.isEmpty {
            if accepting {
                VStack(alignment: .leading, spacing: FieldGuideTokens.Space.sm) {
                    Picker("Reason", selection: $reason) {
                        ForEach(options, id: \.reason) { option in
                            Text(option.label).tag(Optional(option.reason))
                        }
                    }
                    TextField("Note (optional)", text: $note)
                        .textFieldStyle(.roundedBorder)
                    HStack {
                        Button("Accept exception") { Task { await accept() } }
                            .buttonStyle(.borderedProminent).disabled(working || reason == nil)
                            .accessibilityIdentifier("field.explanation.exception.confirm.\(draft.check)")
                        Button("Cancel") { accepting = false }.buttonStyle(.bordered)
                    }
                }
            } else {
                Button("Accept as…") {
                    reason = reason ?? options.first?.reason
                    accepting = true
                }
                .buttonStyle(.bordered)
                .accessibilityIdentifier("field.explanation.exception.accept.\(draft.check)")
            }
        }
    }

    private func label(for reason: DataExceptionReason) -> String {
        options.first { $0.reason == reason }?.label ?? reason.rawValue
    }

    private func accept() async {
        guard let reason, let input = draft.setInput(reason: reason, label: label(for: reason), note: note)
        else { return }
        await run { _ = try await appModel.client.setDataException(input) }
        accepting = false
    }

    private func clear() async {
        guard let input = draft.clearInput() else { return }
        await run { _ = try await appModel.client.clearDataException(input) }
    }

    private func run(_ mutation: () async throws -> Void) async {
        working = true
        defer { working = false }
        do {
            try await mutation()
            onChanged()
        } catch {
            appModel.handle(error)
        }
    }
}

#Preview("Data exception") {
    DataExceptionControl(
        draft: .init(entityID: "PRD-4K7M", check: "product_manufacturer"), isGap: true,
        options: [
            .init(reason: .notApplicable, label: "Not applicable"),
            .init(reason: .unavailable, label: "Unavailable"),
        ],
        recorded: nil, onChanged: {}
    )
    .padding(FieldGuideTokens.Space.lg)
    .background(FieldGuideTokens.canvas)
    .environment(PreviewFixtures.signedInModel())
}
