import CubbyKit
import SwiftUI

/// The shared marker for a value inherited rather than set here (web `InheritedMarker`): always
/// visible after the muted value in list rows, beside the value on detail pages.
struct InheritedMarker: View {
    var body: some View {
        Image(systemName: FieldResolutionState.inheritedSymbol)
            .font(.caption)
            .foregroundStyle(FieldGuideTokens.graphiteSecondary)
            .help("Inherited")
            .accessibilityLabel("Inherited")
    }

    /// A fact's runs as one `Text`, each inherited run followed by the marker, so a
    /// comma-joined list keeps one line and truncates as text.
    static func text(_ segments: [EntityRowPresentation.Fact.Segment]) -> Text {
        segments.enumerated().reduce(Text(verbatim: "")) { line, entry in
            let (index, segment) = entry
            let separator = index == 0 ? "" : ", "
            guard segment.inherited else { return Text("\(line)\(separator)\(segment.text)") }
            return Text(
                "\(line)\(separator)\(segment.text) \(Image(systemName: FieldResolutionState.inheritedSymbol))"
            )
        }
    }
}

#Preview {
    VStack(alignment: .leading, spacing: FieldGuideTokens.Space.sm) {
        HStack(spacing: FieldGuideTokens.Space.xs) {
            Text("Alex").foregroundStyle(FieldGuideTokens.graphiteSecondary)
            InheritedMarker()
        }
        InheritedMarker.text([
            .init(text: "Alex", inherited: true), .init(text: "Household", inherited: false),
        ])
        .foregroundStyle(FieldGuideTokens.graphiteSecondary)
    }
    .padding()
}
