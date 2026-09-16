import CubbyKit
import SwiftUI

/// Products the sweep found stocked elsewhere. One action moves every queued row into the
/// current location; rows with ambiguous quantity move a single unit.
struct StraysView: View {
    let session: ScanSession
    @Environment(\.dismiss) private var dismiss
    @State private var resolving = false
    @State private var summary: String?

    var body: some View {
        NavigationStack {
            List {
                if !session.strays.isEmpty {
                    Eyebrow("\(session.strays.count) stocked elsewhere · swipe a row to skip it")
                        .listRowBackground(PorcelainTokens.canvas)
                        .listRowSeparator(.hidden)
                }
                ForEach(session.strays) { stray in
                    VStack(alignment: .leading, spacing: PorcelainTokens.Space.sm) {
                        HStack(alignment: .firstTextBaseline, spacing: PorcelainTokens.Space.sm) {
                            Text(stray.productName)
                                .font(.porcelainTitle)
                                .foregroundStyle(PorcelainTokens.graphite)
                                .lineLimit(2)
                            Spacer(minLength: PorcelainTokens.Space.sm)
                            Text(stray.productID.rawValue)
                                .font(.porcelainCode)
                                .foregroundStyle(PorcelainTokens.graphiteSecondary)
                        }
                        ForEach(stray.rows) { row in
                            HStack(spacing: PorcelainTokens.Space.sm) {
                                DomainMark(.location)
                                Text(row.location.name)
                                    .font(.porcelainBody)
                                    .foregroundStyle(PorcelainTokens.graphiteSecondary)
                                    .lineLimit(1)
                                if row.ambiguousQuantity {
                                    StatusChip(text: "More than one unit", tone: .warning)
                                }
                            }
                        }
                    }
                    .padding(.vertical, PorcelainTokens.Space.xs)
                    .porcelainListRow()
                    .swipeActions {
                        Button("Skip", role: .destructive) { session.dismissStray(stray.productID) }
                    }
                }
                if let summary {
                    Text(summary)
                        .font(.porcelainBody)
                        .foregroundStyle(PorcelainTokens.graphiteSecondary)
                        .porcelainListRow()
                }
            }
            .listStyle(.plain)
            .porcelainScreen()
            .overlay {
                if session.strays.isEmpty && summary == nil {
                    ContentUnavailableView(
                        "Nothing found elsewhere",
                        systemImage: "tray",
                        description: Text("Scans that turn up stocked in another location queue here.")
                    )
                }
            }
            .navigationTitle("Found elsewhere")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(resolving ? "Moving…" : "Move here") { Task { await resolve() } }
                        .disabled(resolving || session.strays.isEmpty)
                }
            }
        }
        .nativeSheet(.editor)
        .interactiveDismissDisabled(resolving)
    }

    private func resolve() async {
        resolving = true
        defer { resolving = false }
        do {
            if let result = try await session.resolveStrays() {
                let skipped = result.skipped.isEmpty ? "" : " · \(result.skipped.count) skipped"
                summary = "Moved \(result.moved)\(skipped)."
            }
        } catch {
            summary = (error as? CubbyAPIError)?.detail?.message ?? String(describing: error)
            Diagnostics.report(error, context: "capture.resolveStrays")
        }
    }
}

#Preview {
    @Previewable @State var appModel = PreviewFixtures.signedInModel()
    StraysView(session: ScanSession(service: appModel.client))
}
