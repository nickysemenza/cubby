import SwiftUI

#if os(macOS)
    import AppKit
#endif

extension View {
    /// Screen-level keyboard dismissal without overriding the system's surface or scroll edges.
    func fieldGuideScreen() -> some View {
        scrollDismissesKeyboard(.interactively)
    }

    /// A "Done" key above the software keyboard. Attached to a field, it shows only while that
    /// field is focused.
    func keyboardDismissBar() -> some View {
        modifier(KeyboardDismissBar())
    }
}

/// The one failed-load state for a screen or sheet body whose content never arrived: what failed,
/// the raw server message, and Retry. A section or slot beside loaded content uses
/// `InlineLoadFailure` instead.
struct LoadFailureView: View {
    let title: String
    let message: String
    let retry: @MainActor () async -> Void

    var body: some View {
        ContentUnavailableView {
            Label(title, systemImage: "exclamationmark.triangle")
        } description: {
            Text(message)
        } actions: {
            Button("Retry") { Task { await retry() } }
                .buttonStyle(.bordered)
        }
    }
}

/// A failed load inside a section or slot whose siblings stay visible. The warning tone is paired
/// with the symbol, never color alone. `isRetrying` keeps the message up while a retry runs.
struct InlineLoadFailure: View {
    let message: String
    var isRetrying = false
    let retry: @MainActor () async -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: FieldGuideTokens.Space.sm) {
            Label(message, systemImage: "exclamationmark.triangle")
                .font(.callout)
                .foregroundStyle(FieldGuideTokens.warning)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: FieldGuideTokens.Space.sm) {
                // Borderless so a List row fires only the button, not a row-wide tap.
                // The frame sits inside the label: outside it, it grows layout but not the hit area.
                Button {
                    Task { await retry() }
                } label: {
                    Text("Retry")
                        .frame(
                            minWidth: FieldGuideTokens.touchTarget,
                            minHeight: FieldGuideTokens.touchTarget
                        )
                        .contentShape(Rectangle())
                }
                .buttonStyle(.borderless)
                .disabled(isRetrying)
                if isRetrying { LoadingIndicator(label: "Retrying") }
            }
        }
    }
}

#Preview("Load failures") {
    List {
        Section("Inline") {
            InlineLoadFailure(message: "HTTP 503: upstream unavailable") {}
            InlineLoadFailure(message: "HTTP 503: upstream unavailable", isRetrying: true) {}
        }
        LoadFailureView(title: "Couldn't load products", message: "HTTP 503: upstream unavailable") {}
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
    VStack(spacing: FieldGuideTokens.Space.lg) {
        LoadingIndicator(label: "Loading products")
        LoadingIndicator.screen(label: "Loading products")
            .frame(height: 120)
    }
    .padding(FieldGuideTokens.Space.lg)
    .background(FieldGuideTokens.canvas)
}

/// A square-ish shortcut: a ink glyph over a sentence-case label, sized for a two-column grid.
/// Used for the Today shortcuts and the Identify photo sources so both read as the same affordance.
struct ActionTile: View {
    let title: String
    let symbol: String
    var detail: String?

    var body: some View {
        VStack(alignment: .leading, spacing: FieldGuideTokens.Space.sm) {
            Image(systemName: symbol)
                .font(.system(size: 20, weight: .regular))
                .foregroundStyle(FieldGuideTokens.interaction)
                .accessibilityHidden(true)
            Text(title)
                .font(.fieldGuideTitle)
                .foregroundStyle(FieldGuideTokens.graphite)
                .multilineTextAlignment(.leading)

            if let detail {
                Text(detail)
                    .font(.fieldGuideLabel)
                    .foregroundStyle(FieldGuideTokens.graphiteSecondary)

            }
        }
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .padding(FieldGuideTokens.Space.md)
        .frame(minHeight: 84, maxHeight: .infinity, alignment: .topLeading)
        .background(
            RoundedRectangle(cornerRadius: FieldGuideTokens.radiusPanel).fill(FieldGuideTokens.surface)
        )
        .overlay(
            RoundedRectangle(cornerRadius: FieldGuideTokens.radiusPanel)
                .strokeBorder(FieldGuideTokens.hairline, lineWidth: FieldGuideTokens.hairlineWidth)
        )
        .contentShape(RoundedRectangle(cornerRadius: FieldGuideTokens.radiusPanel))
    }
}

/// Two equal columns on the 12pt rhythm — the shape every grid on these screens uses.
let fieldGuideTwoColumns = [
    GridItem(.adaptive(minimum: 160), spacing: FieldGuideTokens.Space.md)
]

#Preview("Action tiles") {
    LazyVGrid(columns: fieldGuideTwoColumns, spacing: FieldGuideTokens.Space.md) {
        ActionTile(title: "Capture", symbol: "barcode.viewfinder", detail: "Sweep a location")
        ActionTile(title: "Browse products", symbol: "shippingbox")
        ActionTile(title: "Identify", symbol: "camera.metering.center.weighted")
        ActionTile(title: "Dev", symbol: "wrench.and.screwdriver")
    }
    .padding(FieldGuideTokens.Space.lg)
    .background(FieldGuideTokens.canvas)
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
                            .font(.fieldGuideBody.weight(.semibold))
                    }
                }
        #else
            content
        #endif
    }
}

/// Presentation role is a property of a task, independent of how its fields are laid out.
enum NativeSheetPurpose {
    case adjustment, picker, editor, photo, photoImport, photoReview, preview
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
                    .frame(minWidth: 360, idealWidth: 560, minHeight: 360, idealHeight: 620)
            case .photoImport:
                content.presentationSizing(.form)
                    .frame(minWidth: 420, idealWidth: 580, minHeight: 320, idealHeight: 520)
            case .photoReview:
                content.presentationSizing(.page)
                    .frame(
                        minWidth: 480, idealWidth: photoReviewSheetSize.width,
                        minHeight: 420, idealHeight: photoReviewSheetSize.height
                    )
                    .task { windowSize = NSApp.keyWindow?.frame.size ?? windowSize }
            case .photo, .preview:
                content.presentationSizing(.page)
                    .frame(
                        minWidth: 480, idealWidth: photoSheetSize.width,
                        minHeight: 420, idealHeight: photoSheetSize.height
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
            case .photoImport:
                content.presentationSizing(.form)
                    .presentationBackground(FieldGuideTokens.canvas)
                    .presentationDetents(
                        textSize.isAccessibilitySize ? [.large] : [.medium, .large],
                        selection: $detent
                    )
                    .presentationDragIndicator(.visible)
                    .onAppear { detent = textSize.isAccessibilitySize ? .large : .medium }
                    .onChange(of: textSize) { if textSize.isAccessibilitySize { detent = .large } }
            case .photo, .photoReview, .preview:
                content.presentationSizing(.page).presentationDetents([.large])
            }
        #endif
    }

    #if os(macOS)
        private var photoReviewSheetSize: CGSize {
            CGSize(
                width: max(480, min(windowSize.width * 0.8, 1050)),
                height: max(420, min(windowSize.height * 0.7, 680)))
        }

        /// ~85% of the window, capped so it never dwarfs a large display and floored so it never
        /// shrinks to uselessness on a small one.
        private var photoSheetSize: CGSize {
            CGSize(
                width: max(480, min(windowSize.width * 0.85, 1400)),
                height: max(420, min(windowSize.height * 0.85, 1000)))
        }
    #endif
}
