import CubbyKit
import SwiftUI

/// What scanning turned up beyond this bin's own expected rows: products stocked elsewhere, and
/// bins that scanned as inside this one but live somewhere else. Strays move as soon as you press
/// "Move here"; adoptions only take effect when the bin's "Done" commits.
struct BinStraysSheet: View {
    let session: RecountSession
    @Environment(\.dismiss) private var dismiss
    @Environment(AppModel.self) private var model
    @State private var resolving = false
    @State private var summary: String?

    var body: some View {
        NavigationStack {
            List {
                foundElsewhereSection
                adoptSection
                summaryRow
            }
            .listStyle(.plain)
            .porcelainScreen()
            .overlay {
                if session.strays.isEmpty && session.adoptions.isEmpty && summary == nil {
                    ContentUnavailableView(
                        "Nothing queued",
                        systemImage: "tray",
                        description: Text("Scans that turn up elsewhere, or a bin scanned as inside this one, queue here.")
                    )
                }
            }
            .navigationTitle("Found while scanning")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(resolving ? "Moving…" : "Move here") { Task { await resolveStrays() } }
                        .disabled(resolving || session.strays.isEmpty)
                }
            }
        }
        #if os(macOS)
        .frame(minWidth: 360, minHeight: 420)
        #endif
    }

    @ViewBuilder
    private var foundElsewhereSection: some View {
        if !session.strays.isEmpty {
            Eyebrow("Found elsewhere")
                .listRowBackground(PorcelainTokens.canvas)
                .listRowSeparator(.hidden)
            ForEach(session.strays) { stray in
                VStack(alignment: .leading, spacing: PorcelainTokens.Space.sm) {
                    Text(stray.productName)
                        .font(.porcelainTitle)
                        .foregroundStyle(PorcelainTokens.graphite)
                        .lineLimit(2)
                    ForEach(stray.rows) { row in
                        HStack(spacing: PorcelainTokens.Space.sm) {
                            DomainMark(.location)
                            Text("in \(row.locationName)")
                                .font(.porcelainBody)
                                .foregroundStyle(PorcelainTokens.graphiteSecondary)
                                .lineLimit(1)
                            if row.ambiguousQuantity {
                                StatusChip(text: "1 of several units", tone: .warning)
                            }
                        }
                    }
                }
                .padding(.vertical, PorcelainTokens.Space.xs)
                .porcelainListRow()
                .swipeActions {
                    Button("Dismiss", role: .destructive) { session.dismissStray(stray.productID) }
                }
            }
        }
    }

    @ViewBuilder
    private var adoptSection: some View {
        if !session.adoptions.isEmpty {
            Eyebrow("Bins to adopt")
                .listRowBackground(PorcelainTokens.canvas)
                .listRowSeparator(.hidden)
            ForEach(session.adoptions) { bin in
                VStack(alignment: .leading, spacing: 2) {
                    Text("\(bin.name) — now in \(bin.currentParentName)")
                        .font(.porcelainBody)
                        .foregroundStyle(PorcelainTokens.graphite)
                        .lineLimit(2)
                    Text("Adopted when you press Done.")
                        .font(.porcelainLabel)
                        .foregroundStyle(PorcelainTokens.graphiteSecondary)
                }
                .porcelainListRow()
                .swipeActions {
                    Button("Dismiss", role: .destructive) { session.dismissAdoption(bin.id) }
                }
            }
        }
    }

    @ViewBuilder
    private var summaryRow: some View {
        if let summary {
            Text(summary)
                .font(.porcelainBody)
                .foregroundStyle(PorcelainTokens.graphiteSecondary)
                .listRowBackground(PorcelainTokens.canvas)
                .listRowSeparator(.hidden)
        }
    }

    private func resolveStrays() async {
        resolving = true
        defer { resolving = false }
        do {
            if let result = try await session.resolveStrays() {
                let skipped = result.skipped.isEmpty ? "" : " · \(result.skipped.count) skipped"
                summary = "Moved \(result.moved)\(skipped)."
            }
        } catch let error as CubbyAPIError {
            // A 401 here means the middleware already dropped the credential; tell the app so it
            // follows the session out instead of leaving this sheet open on a dead login.
            model.handle(error)
            summary = error.detail?.message ?? "HTTP \(error.status)"
        } catch {
            summary = String(describing: error)
        }
    }
}

#Preview("Strays and adoptions") {
    BinStraysSheet(session: RecountSession(service: PreviewFixtures.signedInModel().client))
        .environment(PreviewFixtures.signedInModel())
}
