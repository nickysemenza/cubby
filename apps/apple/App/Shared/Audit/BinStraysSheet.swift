import CubbyKit
import SwiftUI

/// What scanning turned up beyond this bin's own expected rows: products stocked elsewhere, and
/// bins that scanned as inside this one but live somewhere else. Strays move as soon as you press
/// "Move N here now"; adoptions only take effect when the bin's Done commits.
struct BinStraysSheet: View {
    let session: RecountSession
    @Environment(\.dismiss) private var dismiss
    @Environment(AppModel.self) private var model
    @State private var resolving = false
    @State private var summary: String?
    @State private var failure: String?

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
                if session.strays.isEmpty && session.adoptions.isEmpty && summary == nil && failure == nil {
                    ContentUnavailableView(
                        "No items to move here",
                        systemImage: "tray",
                        description: Text(
                            "Products stocked elsewhere and bins scanned inside this one appear here.")
                    )
                }
            }
            .navigationTitle("Found while scanning")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } }
                // Strays move as soon as this runs; adoptions wait for the bin's Done, so the
                // action only exists while there is a stray to move.
                if !session.strays.isEmpty || resolving {
                    ToolbarItem(placement: .confirmationAction) {
                        Button(resolving ? "Moving…" : moveTitle) { Task { await resolveStrays() } }
                            .disabled(resolving)
                    }
                }
            }
        }
        .nativeSheet(.editor)
        .interactiveDismissDisabled(resolving)
    }

    private var moveTitle: String {
        session.strays.count == 1 ? "Move 1 here now" : "Move \(session.strays.count) here now"
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
                            FieldValueStatus(
                                raw: (try? JSONValue(encoding: row)) ?? .null,
                                field: EntityCatalog[.inventory].field("amount"))
                        }
                    }
                }
                .padding(.vertical, FieldGuideTokens.Space.xs)
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
                    Text("Adopted when you finish this bin.")
                        .font(.fieldGuideLabel)
                        .foregroundStyle(FieldGuideTokens.graphiteSecondary)
                }
                .swipeActions {
                    Button("Dismiss", role: .destructive) { session.dismissAdoption(bin.id) }
                }
            }
        }
    }

    @ViewBuilder
    private var summaryRow: some View {
        if let failure {
            // The Move action stays in the toolbar, so the notice offers no second retry.
            ActionFailureNotice(title: "Couldn't move", message: failure)
                .listRowBackground(FieldGuideTokens.canvas)
                .listRowSeparator(.hidden)
        }
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
        failure = nil
        do {
            if let result = try await session.resolveStrays() {
                let skipped = result.skipped.isEmpty ? "" : " · \(result.skipped.count) skipped"
                summary = "Moved \(result.moved)\(skipped)."
            }
        } catch let error as CubbyAPIError {
            // A 401 here means the middleware already dropped the credential; tell the app so it
            // follows the session out instead of leaving this sheet open on a dead login.
            model.handle(error)
            failure = error.userMessage
        } catch {
            failure = error.userMessage
            Diagnostics.report(error, context: "audit.resolveStrays")
        }
    }
}

#Preview("Strays and adoptions") {
    @Previewable @State var appModel = PreviewFixtures.signedInModel()
    BinStraysSheet(session: RecountSession(service: appModel.client))
        .environment(appModel)
}
