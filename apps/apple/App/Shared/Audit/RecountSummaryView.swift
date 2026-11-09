import CubbyKit
import SwiftUI

/// The end of a walk: how many bins finished or were skipped, what changed (adjusted, removed and
/// moved disclosed separately), and the two ways to keep going — count the skipped bins, or start
/// a fresh walk over a different scope.
struct RecountSummaryView: View {
    let session: RecountSession

    var body: some View {
        RecountSummaryContent(
            summary: session.summary,
            canRevisitSkipped: session.summary.binsSkipped > 0,
            onRevisitSkipped: { Task { await session.revisitSkipped() } },
            onCountAnother: { session.restart() }
        )
    }
}

/// The plain-data half of `RecountSummaryView`, so its `#Preview` can feed it a populated summary
/// instead of a network call.
private struct RecountSummaryContent: View {
    let summary: RecountSummary
    let canRevisitSkipped: Bool
    let onRevisitSkipped: () -> Void
    let onCountAnother: () -> Void

    var body: some View {
        List {
            Section {
                LabeledContent("Verified", value: ValueFormat.count(summary.verified))
                DisclosureGroup {
                    LabeledContent("Counts adjusted", value: ValueFormat.count(summary.adjusted))
                    LabeledContent("Removed", value: ValueFormat.count(summary.removed))
                    LabeledContent("Moved elsewhere", value: ValueFormat.count(summary.relocated))
                } label: {
                    LabeledContent("Changed", value: ValueFormat.count(summary.changed))
                }
                LabeledContent("Added from scans", value: ValueFormat.count(summary.added))
                LabeledContent("Bins adopted", value: ValueFormat.count(summary.adopted))
            } header: {
                Text(headline)
            } footer: {
                if summary.binsSkipped > 0 {
                    Text("Skipped bins were left unchanged.")
                }
            }
            Section {
                if canRevisitSkipped {
                    Button(revisitTitle, action: onRevisitSkipped)
                        .accessibilityIdentifier("audit.revisitSkipped")
                }
                Button("Count another", action: onCountAnother)
                    .accessibilityIdentifier("audit.countAnother")
            }
        }
    }

    /// Finished and skipped bins in one line: a walk with skips is not complete.
    private var headline: String {
        let finished =
            "\(ValueFormat.count(summary.binsDone)) \(summary.binsDone == 1 ? "bin" : "bins") finished"
        guard summary.binsSkipped > 0 else { return finished }
        return "\(finished) · \(ValueFormat.count(summary.binsSkipped)) skipped"
    }

    private var revisitTitle: String {
        "Count \(ValueFormat.count(summary.binsSkipped)) skipped \(summary.binsSkipped == 1 ? "bin" : "bins")"
    }
}

/// A populated summary for the preview above. A plain function, not inline in the `#Preview`
/// body: a `ViewBuilder` closure can hold `let`/`var` declarations but not the mutating
/// assignments needed to fill in `RecountSummary`'s fields one at a time.
private func sampleSummary() -> RecountSummary {
    var summary = RecountSummary()
    summary.verified = 42
    summary.adjusted = 3
    summary.removed = 1
    summary.relocated = 2
    summary.added = 5
    summary.adopted = 1
    summary.binsDone = 11
    summary.binsSkipped = 2
    return summary
}

#Preview("Summary") {
    RecountSummaryContent(
        summary: sampleSummary(), canRevisitSkipped: true, onRevisitSkipped: {}, onCountAnother: {}
    )
}

#Preview("Summary — nothing skipped") {
    RecountSummaryContent(
        summary: RecountSummary(), canRevisitSkipped: false, onRevisitSkipped: {}, onCountAnother: {}
    )
}

#Preview("Recount summary view") {
    @Previewable @State var appModel = PreviewFixtures.signedInModel()
    RecountSummaryView(session: RecountSession(service: appModel.client))
        .environment(appModel)
}
