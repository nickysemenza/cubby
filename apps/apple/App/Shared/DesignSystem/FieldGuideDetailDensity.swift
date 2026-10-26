import SwiftUI

extension View {
    /// Shared row inset and section spacing for native List and Form content.
    func fieldGuideSectionStyle() -> some View {
        self
            .listRowInsets(
                EdgeInsets(
                    top: 2, leading: FieldGuideTokens.Space.md,
                    bottom: 2, trailing: FieldGuideTokens.Space.md)
            )
            .contentMargins(.horizontal, FieldGuideTokens.Space.md, for: .scrollContent)
            #if os(iOS)
                .listSectionSpacing(.compact)
            #endif
    }

    /// Shared detail chrome: a compact canvas around native rows, with system text scaling.
    func fieldGuideDetailDensity() -> some View {
        self
            #if os(iOS)
                .environment(\.defaultMinListRowHeight, 30)
            #endif
            .fieldGuideSectionStyle()
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
