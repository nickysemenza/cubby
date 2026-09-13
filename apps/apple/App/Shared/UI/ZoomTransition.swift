import SwiftUI

extension EnvironmentValues {
    /// The namespace `SectionView` opens for whichever section is on screen, so a list or search
    /// row deep in that section's view tree can mark its thumbnail as the `.matchedTransitionSource`
    /// for the zoom transition into `EntityDetailView`. `nil` outside a `SectionView` (previews, or
    /// a platform where the transition is off) — `zoomSource` below is a no-op in that case.
    @Entry var zoomNamespace: Namespace.ID?
}

extension View {
    /// `.matchedTransitionSource(id:in:)`, applied only when an ancestor `SectionView` actually
    /// published a namespace. iOS only (see `SectionView`'s doc comment); a no-op on macOS and in
    /// previews, so call sites never need their own platform `#if`.
    @ViewBuilder
    func zoomSource(id: String, in namespace: Namespace.ID?) -> some View {
        #if os(iOS)
            if let namespace {
                self.matchedTransitionSource(id: id, in: namespace)
            } else {
                self
            }
        #else
            self
        #endif
    }
}
