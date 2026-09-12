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
                ForEach(session.strays) { stray in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(stray.productName)
                        ForEach(stray.rows) { row in
                            Text("\(row.locationName)\(row.ambiguousQuantity ? " · more than one unit there" : "")")
                                .font(.footnote)
                                .foregroundStyle(PorcelainTokens.graphiteSecondary)
                        }
                    }
                    .swipeActions {
                        Button("Skip", role: .destructive) { session.dismissStray(stray.productID) }
                    }
                }
                if let summary {
                    Section { Text(summary) }
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
        #if os(macOS)
        .frame(minWidth: 360, minHeight: 320)
        #endif
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
        }
    }
}
