import CubbyKit
import SwiftUI

/// An AI answer the server already saved, set beside what it replaced. Both sides, the model and
/// its age come from the server's answer. The write happened when the analysis ran, so the sheet
/// reports a saved result and offers only Done; it never stages an approval it cannot make.
struct AIReviewSheet: View {
    let review: HeroActionReview
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: FieldGuideTokens.Space.md) {
                    Label("Saved to this record", systemImage: "checkmark.circle.fill")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(FieldGuideTokens.positive)
                        .accessibilityIdentifier("aiReview.saved")
                    section("Saved result", review.proposed)
                    if let previous = review.previous, !previous.isEmpty {
                        section("Previous", previous, secondary: true)
                    }
                    VStack(alignment: .leading, spacing: FieldGuideTokens.Space.xs) {
                        Label("\(review.confidence.capitalized) confidence", systemImage: "sparkles")
                            .font(.fieldGuideLabel)
                        Text(review.reasoning)
                        Text(provenance)
                        DateDisplay(date: review.analyzedAt)
                    }
                    .font(.caption).foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(FieldGuideTokens.Space.md)
            }
            .navigationTitle(review.label)
            #if os(iOS)
                .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }.accessibilityIdentifier("aiReview.done")
                }
            }
        }
    }

    private func section(_ title: String, _ text: String, secondary: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: FieldGuideTokens.Space.xs) {
            Text(title).font(.fieldGuideLabel).foregroundStyle(.secondary)
            Text(text).foregroundStyle(secondary ? Color.secondary : Color.primary)
                .textSelection(.enabled)
        }
        .accessibilityElement(children: .combine)
    }

    private var provenance: String {
        let source = review.cacheStatus == "hit" ? "Replayed a stored analysis" : "Read the photos again"
        return "\(source) · \(review.model)"
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
