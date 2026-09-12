import CubbyKit
import SwiftUI

/// The end of a walk: what changed, and the two ways to keep going — pick up the bins that were
/// skipped, or start a fresh walk over a different scope.
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
        ScrollView {
            VStack(alignment: .leading, spacing: PorcelainTokens.Space.xl) {
                Eyebrow("Walk complete")
                LazyVGrid(columns: porcelainTwoColumns, spacing: PorcelainTokens.Space.md) {
                    StatTile(label: "Verified", value: "\(summary.verified)")
                    StatTile(label: "Changed", value: "\(summary.changed)")
                    StatTile(label: "Added", value: "\(summary.added)")
                    StatTile(label: "Adopted", value: "\(summary.adopted)")
                    StatTile(label: "Bins done", value: "\(summary.binsDone)")
                    StatTile(label: "Bins skipped", value: "\(summary.binsSkipped)")
                }
                VStack(spacing: PorcelainTokens.Space.sm) {
                    if canRevisitSkipped {
                        Button(action: onRevisitSkipped) {
                            Text("Revisit skipped").frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.borderedProminent)
                        .tint(PorcelainTokens.cobalt)
                        .frame(height: PorcelainTokens.touchTarget)
                    }
                    Button(action: onCountAnother) {
                        Text("Count another").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                    .frame(height: PorcelainTokens.touchTarget)
                }
            }
            .padding(PorcelainTokens.Space.lg)
            .frame(maxWidth: PorcelainTokens.readingWidth, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
        .porcelainScreen()
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
    RecountSummaryView(session: RecountSession(service: PreviewFixtures.signedInModel().client))
        .environment(PreviewFixtures.signedInModel())
}
