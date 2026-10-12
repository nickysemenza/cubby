import SwiftUI

extension View {
    /// Shared detail chrome: a compact canvas around native rows, with system text scaling.
    func fieldGuideDetailDensity() -> some View {
        self
            #if os(iOS)
                .environment(\.defaultMinListRowHeight, FieldGuideTokens.touchTarget)
            #endif
            .listRowInsets(
                EdgeInsets(
                    top: FieldGuideTokens.Space.xs, leading: FieldGuideTokens.Space.md,
                    bottom: FieldGuideTokens.Space.xs, trailing: FieldGuideTokens.Space.md)
            )
            .contentMargins(.horizontal, FieldGuideTokens.Space.md, for: .scrollContent)
            #if os(iOS)
                .listSectionSpacing(.compact)
            #endif
    }
}

#Preview("Compact detail") {
    Form {
        Section("Essentials") {
            LabeledContent("Status", value: "Ready")
            Button("Open evidence") {}
        }
    }
    .fieldGuideDetailDensity()
}
