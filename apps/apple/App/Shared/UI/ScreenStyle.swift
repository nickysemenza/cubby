import SwiftUI

#if os(macOS)
    import AppKit
#endif

extension View {
    /// Screen-level keyboard dismissal without overriding the system's surface or scroll edges.
    func porcelainScreen() -> some View {
        scrollDismissesKeyboard(.interactively)
    }

    /// A "Done" key above the software keyboard. Attached to a field, it shows only while that
    /// field is focused.
    func keyboardDismissBar() -> some View {
        modifier(KeyboardDismissBar())
    }

    /// Compatibility for specialized lists: the system owns row surfaces and separators.
    func porcelainListRow() -> some View {
        self
    }

}

/// A `ProgressView` with an accessibility label — a bare `ProgressView()` reads nothing to
/// VoiceOver. Use the plain initializer inline (a button spinner, a row); use `.screen(label:)`
/// when it is the entire body of a loading screen, centered and filling the available space.
struct LoadingIndicator: View {
    var label: String = "Loading"

    var body: some View {
        ProgressView(label)
    }

    static func screen(label: String = "Loading") -> some View {
        LoadingIndicator(label: label)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

#Preview("Loading indicator") {
    VStack(spacing: PorcelainTokens.Space.lg) {
        LoadingIndicator(label: "Loading products")
        LoadingIndicator.screen(label: "Loading products")
            .frame(height: 120)
    }
    .padding(PorcelainTokens.Space.lg)
    .background(PorcelainTokens.canvas)
}

/// A square-ish shortcut: a cobalt glyph over a sentence-case label, sized for a two-column grid.
/// Used for the Today shortcuts and the Identify photo sources so both read as the same affordance.
struct ActionTile: View {
    let title: String
    let symbol: String
    var detail: String?

    var body: some View {
        VStack(alignment: .leading, spacing: PorcelainTokens.Space.sm) {
            Image(systemName: symbol)
                .font(.system(size: 20, weight: .regular))
                .foregroundStyle(PorcelainTokens.cobalt)
                .accessibilityHidden(true)
            Text(title)
                .font(.porcelainTitle)
                .foregroundStyle(PorcelainTokens.graphite)
                .multilineTextAlignment(.leading)

            if let detail {
                Text(detail)
                    .font(.porcelainLabel)
                    .foregroundStyle(PorcelainTokens.graphiteSecondary)

            }
        }
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .padding(PorcelainTokens.Space.md)
        .frame(minHeight: 84, maxHeight: .infinity, alignment: .topLeading)
        .background(
            RoundedRectangle(cornerRadius: PorcelainTokens.radiusPanel).fill(PorcelainTokens.surface)
        )
        .overlay(
            RoundedRectangle(cornerRadius: PorcelainTokens.radiusPanel)
                .strokeBorder(PorcelainTokens.hairline, lineWidth: PorcelainTokens.hairlineWidth)
        )
        .contentShape(RoundedRectangle(cornerRadius: PorcelainTokens.radiusPanel))
    }
}

/// Two equal columns on the 12pt rhythm — the shape every grid on these screens uses.
let porcelainTwoColumns = [
    GridItem(.adaptive(minimum: 160), spacing: PorcelainTokens.Space.md)
]

#Preview("Action tiles") {
    LazyVGrid(columns: porcelainTwoColumns, spacing: PorcelainTokens.Space.md) {
        ActionTile(title: "Capture", symbol: "barcode.viewfinder", detail: "Sweep a location")
        ActionTile(title: "Browse products", symbol: "shippingbox")
        ActionTile(title: "Identify", symbol: "camera.metering.center.weighted")
        ActionTile(title: "Dev", symbol: "wrench.and.screwdriver")
    }
    .padding(PorcelainTokens.Space.lg)
    .background(PorcelainTokens.canvas)
}

/// SwiftUI focus state, not a UIKit `resignFirstResponder` hack: the modifier owns a focus flag
/// for the field it wraps and clears it from the Done key.
private struct KeyboardDismissBar: ViewModifier {
    @FocusState private var focused: Bool

    func body(content: Content) -> some View {
        #if os(iOS)
            content
                .focused($focused)
                .toolbar {
                    ToolbarItemGroup(placement: .keyboard) {
                        Spacer()
                        Button("Done") { focused = false }
                            .font(.porcelainBody.weight(.semibold))
                    }
                }
        #else
            content
        #endif
    }
}

/// Presentation role is a property of a task, independent of how its fields are laid out.
enum NativeSheetPurpose {
    case adjustment, picker, editor, photo, preview
}

extension View {
    func nativeSheet(_ purpose: NativeSheetPurpose) -> some View {
        modifier(NativeSheetPresentation(purpose: purpose))
    }
}

private struct NativeSheetPresentation: ViewModifier {
    let purpose: NativeSheetPurpose
    @Environment(\.dynamicTypeSize) private var textSize
    @State private var detent: PresentationDetent = .medium
    #if os(macOS)
        // Q1b: the photo review sheet tracks the window instead of a fixed size that clipped on
        // a large display and wasted space on a small one. Read once in `.task` (the window isn't
        // reliably available before the sheet's first layout pass) rather than reactively — good
        // enough for "opens sized to the window", not worth a live-resize observer.
        @State private var windowSize = CGSize(width: 960, height: 620)
    #endif

    func body(content: Content) -> some View {
        #if os(macOS)
            switch purpose {
            case .adjustment:
                content.presentationSizing(.form)
                    .frame(minWidth: 320, idealWidth: 380, minHeight: 220)
            case .picker, .editor:
                content.presentationSizing(.form)
                    .frame(minWidth: 480, idealWidth: 620, minHeight: 440, idealHeight: 680)
            case .photo, .preview:
                content.presentationSizing(.page)
                    .frame(
                        minWidth: 960, idealWidth: photoSheetSize.width,
                        minHeight: 620, idealHeight: photoSheetSize.height
                    )
                    .task { windowSize = NSApp.keyWindow?.frame.size ?? windowSize }
            }
        #else
            switch purpose {
            case .adjustment:
                content.presentationSizing(.form)
                    .presentationDetents(
                        textSize.isAccessibilitySize ? [.large] : [.medium, .large], selection: $detent
                    )
                    .presentationDragIndicator(.visible)
                    .onAppear { detent = textSize.isAccessibilitySize ? .large : .medium }
                    .onChange(of: textSize) { if textSize.isAccessibilitySize { detent = .large } }
            case .picker, .editor:
                content.presentationSizing(.form).presentationDetents([.large])
            case .photo, .preview:
                content.presentationSizing(.page).presentationDetents([.large])
            }
        #endif
    }

    #if os(macOS)
        /// ~85% of the window, capped so it never dwarfs a large display and floored so it never
        /// shrinks to uselessness on a small one.
        private var photoSheetSize: CGSize {
            CGSize(
                width: max(960, min(windowSize.width * 0.85, 1400)),
                height: max(620, min(windowSize.height * 0.85, 1000)))
        }
    #endif
}
