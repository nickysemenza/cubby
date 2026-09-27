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
            .fieldGuideScreen()
            .overlay {
                if session.strays.isEmpty && session.adoptions.isEmpty && summary == nil {
                    ContentUnavailableView(
                        "Nothing queued",
                        systemImage: "tray",
                        description: Text(
                            "Scans that turn up elsewhere, or a bin scanned as inside this one, queue here.")
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
        .nativeSheet(.editor)
        .interactiveDismissDisabled(resolving)
    }

    @ViewBuilder
    private var foundElsewhereSection: some View {
        if !session.strays.isEmpty {
            Eyebrow("Found elsewhere")
                .listRowBackground(FieldGuideTokens.canvas)
                .listRowSeparator(.hidden)
            ForEach(session.strays) { stray in
                VStack(alignment: .leading, spacing: FieldGuideTokens.Space.sm) {
                    Text(stray.productName)
                        .font(.fieldGuideTitle)
                        .foregroundStyle(FieldGuideTokens.graphite)
                        .lineLimit(2)
                    ForEach(stray.rows) { row in
                        HStack(spacing: FieldGuideTokens.Space.sm) {
                            DomainMark(.location)
                            Text("in \(row.location.name)")
                                .font(.fieldGuideBody)
                                .foregroundStyle(FieldGuideTokens.graphiteSecondary)
                                .lineLimit(1)
                            if row.ambiguousQuantity {
                                StatusChip(text: "1 of several units", tone: .warning)
                            }
                        }
                    }
                }
                .padding(.vertical, FieldGuideTokens.Space.xs)
                .fieldGuideListRow()
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
                .listRowBackground(FieldGuideTokens.canvas)
                .listRowSeparator(.hidden)
            ForEach(session.adoptions) { bin in
                VStack(alignment: .leading, spacing: 2) {
                    Text("\(bin.name) — now in \(bin.currentParentName)")
                        .font(.fieldGuideBody)
                        .foregroundStyle(FieldGuideTokens.graphite)
                        .lineLimit(2)
                    Text("Adopted when you press Done.")
                        .font(.fieldGuideLabel)
                        .foregroundStyle(FieldGuideTokens.graphiteSecondary)
                }
                .fieldGuideListRow()
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
                .font(.fieldGuideBody)
                .foregroundStyle(FieldGuideTokens.graphiteSecondary)
                .listRowBackground(FieldGuideTokens.canvas)
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
            Diagnostics.report(error, context: "audit.resolveStrays")
        }
    }
}

#Preview("Strays and adoptions") {
    @Previewable @State var appModel = PreviewFixtures.signedInModel()
    BinStraysSheet(session: RecountSession(service: appModel.client))
        .environment(appModel)
}
