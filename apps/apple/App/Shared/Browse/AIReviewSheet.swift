import CubbyKit
import SwiftUI

/// An AI answer the server already saved, set beside what it replaced. Both sides, the model and
/// its age come from the server's answer; Keep and Hide only close the sheet (the write happened
/// when the analysis ran), exactly as on web.
struct AIReviewSheet: View {
    let review: HeroActionReview
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: FieldGuideTokens.Space.md) {
                    Label("\(review.confidence.capitalized) confidence", systemImage: "sparkles")
                        .font(.fieldGuideLabel).foregroundStyle(.secondary)
                    Text(review.reasoning).font(.footnote).foregroundStyle(.secondary)
                    if let previous = review.previous, !previous.isEmpty {
                        section("Current", previous, secondary: true)
                    }
                    section(review.previous == nil ? "New" : "Proposed", review.proposed)
                    Text(provenance).font(.caption).foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(FieldGuideTokens.Space.md)
            }
            .navigationTitle(review.label)
            #if os(iOS)
                .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Hide") { dismiss() }.accessibilityIdentifier("aiReview.hide")
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Keep") { dismiss() }.accessibilityIdentifier("aiReview.keep")
                }
            }
        }
    }

    private func section(_ title: String, _ text: String, secondary: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: FieldGuideTokens.Space.xs) {
            Text(title.uppercased()).font(.fieldGuideLabel).foregroundStyle(.secondary)
            Text(text).foregroundStyle(secondary ? Color.secondary : Color.primary)
                .textSelection(.enabled)
        }
    }

    private var provenance: String {
        let age = review.analyzedAt.formatted(date: .abbreviated, time: .shortened)
        let source = review.cacheStatus == "hit" ? "Replayed a stored analysis" : "Read the photos again"
        return "\(source) · \(review.model) · \(age)"
    }
}

#Preview("AI review") {
    AIReviewSheet(
        review: HeroActionReview(
            label: "Analyzed contents", previous: "Shelves of jars.",
            proposed: "Shelves of jars and a folded tarp.", confidence: "high",
            reasoning: "Read from this location's photos.", model: "sample-model",
            analyzedAt: Date(timeIntervalSince1970: 1_780_000_000), cacheStatus: "miss", changed: [.location])
    )
}
