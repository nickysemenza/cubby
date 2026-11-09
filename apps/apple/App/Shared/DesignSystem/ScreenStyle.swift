import SwiftUI

#if os(iOS)
    import UIKit
#endif

#if os(macOS)
    import AppKit
#endif

extension View {
    /// Screen-level keyboard dismissal without overriding the system's surface or scroll edges.
    func fieldGuideScreen() -> some View {
        scrollDismissesKeyboard(.interactively)
    }

    /// A "Done" key above the software keyboard for a field or its containing editor.
    func keyboardDismissBar() -> some View {
        modifier(KeyboardDismissBar())
    }

    /// A leading glyph column whose width grows with Dynamic Type, so a scaled glyph is never
    /// clipped by a fixed slot and the row's text stays aligned across rows.
    func fieldGuideIconSlot(width: CGFloat = 20, relativeTo textStyle: Font.TextStyle = .body) -> some View {
        modifier(IconSlot(width: width, textStyle: textStyle))
    }
}

private struct IconSlot: ViewModifier {
    @ScaledMetric private var width: CGFloat

    init(width: CGFloat, textStyle: Font.TextStyle) {
        _width = ScaledMetric(wrappedValue: width, relativeTo: textStyle)
    }

    func body(content: Content) -> some View {
        content.frame(width: width)
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
            DiagnosticMessage(message: message)
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
    @Environment(\.dynamicTypeSize) private var textSize

    var body: some View {
        let layout =
            textSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: FieldGuideTokens.Space.sm))
            : AnyLayout(HStackLayout(alignment: .top, spacing: FieldGuideTokens.Space.sm))
        layout {
            Label {
                DiagnosticMessage(message: message)
            } icon: {
                Image(systemName: "exclamationmark.triangle")
            }
            .font(.callout)
            .foregroundStyle(FieldGuideTokens.warning)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
            HStack(spacing: FieldGuideTokens.Space.sm) {
                // Borderless so a List row fires only the button, not a row-wide tap.
                // The frame sits inside the label: outside it, it grows layout but not the hit area.
                Button {
                    Task { await retry() }
                } label: {
                    Label("Retry", systemImage: "arrow.clockwise")
                        .frame(
                            minWidth: retryTarget,
                            minHeight: retryTarget
                        )
                        .contentShape(Rectangle())
                }
                .buttonStyle(.borderless)
                .disabled(isRetrying)
                .fixedSize()
                if isRetrying { LoadingIndicator(label: "Retrying") }
            }
        }
    }

    private var retryTarget: CGFloat {
        #if os(iOS)
            FieldGuideTokens.touchTarget
        #else
            24
        #endif
    }
}

/// A write the user asked for (a save, an accept) that the server refused. Not a failed load:
/// the user's input stays where it is, and the raw message sits above it. Retry resends the same
/// mutation, so the caller owns `canRetry` (still valid, nothing in flight); pass no `retry`
/// where the failed action's own control is how the user tries again.
struct ActionFailureNotice: View {
    var title = "Couldn't save"
    let message: String
    var canRetry = true
    var retry: (() -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: FieldGuideTokens.Space.sm) {
            Label {
                VStack(alignment: .leading, spacing: FieldGuideTokens.Space.xs) {
                    Text(title).font(.callout.weight(.semibold))
                    DiagnosticMessage(message: message)
                        .font(.callout)
                        .foregroundStyle(FieldGuideTokens.graphite)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                }
            } icon: {
                Image(systemName: "exclamationmark.octagon")
            }
            .foregroundStyle(FieldGuideTokens.destructive)
            if let retry {
                // Borderless so a List row fires only the button, not a row-wide tap.
                // The frame sits inside the label: outside it, it grows layout but not the hit area.
                Button(action: retry) {
                    Text("Retry")
                        .frame(
                            minWidth: FieldGuideTokens.touchTarget,
                            minHeight: FieldGuideTokens.touchTarget, alignment: .leading
                        )
                        .contentShape(Rectangle())
                }
                .buttonStyle(.borderless)
                .disabled(!canRetry)
            }
        }
    }
}

/// Keeps recovery beside the task while retaining the complete original diagnostic for inspection.
struct DiagnosticMessage: View {
    let message: String

    private var needsDisclosure: Bool {
        message.count > 220 || message.split(separator: "\n").count > 3
    }

    var body: some View {
        VStack(alignment: .leading, spacing: FieldGuideTokens.Space.xs) {
            Text(
                needsDisclosure ? String(message.split(separator: "\n").first ?? Substring(message)) : message
            )
            .lineLimit(needsDisclosure ? 3 : nil)
            .fixedSize(horizontal: false, vertical: true)
            if needsDisclosure {
                DisclosureGroup("Technical details") {
                    ScrollView {
                        Text(message)
                            .font(.fieldGuideCode)
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .frame(maxHeight: 180)
                    Button("Copy diagnostic", systemImage: "document.on.document") {
                        Clipboard.copy(message)
                    }
                    .buttonStyle(.borderless)
                }
                .font(.callout)
                .foregroundStyle(.primary)
            }
        }
    }
}

#Preview("Long diagnostic") {
    InlineLoadFailure(
        message: "HTTP 503: synthetic upstream unavailable\n"
            + String(repeating: "Nested cause: synthetic transport refused the request.\n", count: 12)
    ) {}
    .padding()
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

#Preview("Action failures") {
    Form {
        Section {
            ActionFailureNotice(
                message: "PRECONDITION_FAILED: Cannot set parent: would create a circular reference"
            ) {}
        }
        Section {
            ActionFailureNotice(message: "HTTP 503: upstream unavailable", canRetry: false) {}
        }
        Section {
            ActionFailureNotice(message: "CONFLICT: the suggestion changed")
        }
    }
}

/// A `ProgressView` with an accessibility label — a bare `ProgressView()` reads nothing to
/// VoiceOver. Use the plain initializer inline (a button spinner, a row); use `.screen(label:)`
/// when it is the entire body of a loading screen, centered and filling the available space.
struct LoadingIndicator: View {
    var label: String = "Loading"

    var body: some View {
        HStack(spacing: FieldGuideTokens.Space.sm) {
            ProgressView().controlSize(.small).accessibilityHidden(true)
            Text(label)
        }
        .font(.callout)
        .foregroundStyle(.secondary)
        .accessibilityElement(children: .combine)
    }

    static func screen(label: String = "Loading") -> some View {
        ProgressView(label)
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

/// A shared shortcut: a compact horizontal label on Mac and a touch-sized tile on iOS.
struct ActionTile: View {
    let title: String
    let symbol: String
    var detail: String?

    var body: some View {
        #if os(macOS)
            let layout = AnyLayout(HStackLayout(alignment: .center, spacing: FieldGuideTokens.Space.sm))
        #else
            let layout = AnyLayout(VStackLayout(alignment: .leading, spacing: FieldGuideTokens.Space.sm))
        #endif
        layout {
            Image(systemName: symbol)
                .font(.body)
                .foregroundStyle(FieldGuideTokens.interaction)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: FieldGuideTokens.Space.xs) {
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
        }
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .padding(FieldGuideTokens.Space.md)
        .frame(minHeight: minimumHeight, maxHeight: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: FieldGuideTokens.radiusPanel).fill(FieldGuideTokens.surface)
        )
        .overlay(
            RoundedRectangle(cornerRadius: FieldGuideTokens.radiusPanel)
                .strokeBorder(FieldGuideTokens.hairline, lineWidth: FieldGuideTokens.hairlineWidth)
        )
        .contentShape(RoundedRectangle(cornerRadius: FieldGuideTokens.radiusPanel))
    }

    private var minimumHeight: CGFloat {
        #if os(macOS)
            44
        #else
            84
        #endif
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
    func body(content: Content) -> some View {
        #if os(iOS)
            content
                .toolbar {
                    ToolbarItemGroup(placement: .keyboard) {
                        Spacer()
                        // A Form-level focus binding does not own its descendants' focus.
                        Button("Done") {
                            UIApplication.shared.sendAction(
                                #selector(UIResponder.resignFirstResponder),
                                to: nil, from: nil, for: nil)
                        }
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
