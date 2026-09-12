import SwiftUI

extension View {
    /// The porcelain canvas behind a screen. Safe on any container: the hidden scroll background
    /// is a no-op where there is nothing scrolling.
    func porcelainScreen() -> some View {
        scrollContentBackground(.hidden)
            .background(PorcelainTokens.canvas)
            // Dragging any screen's content dismisses the keyboard; a permanent entry field with
            // no Done key otherwise traps it on iOS.
            .scrollDismissesKeyboard(.interactively)
    }

    /// A "Done" key above the software keyboard. Attached to a field, it shows only while that
    /// field is focused.
    func keyboardDismissBar() -> some View {
        modifier(KeyboardDismissBar())
    }

    /// White row over the canvas, with the cool hairline as the separator. Applied per row so a
    /// plain `List` reads as a stack of working planes rather than a stock grouped form.
    func porcelainListRow() -> some View {
        listRowBackground(PorcelainTokens.surface)
            .listRowSeparatorTint(PorcelainTokens.hairline)
    }
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
                .lineLimit(2)
            if let detail {
                Text(detail)
                    .font(.porcelainLabel)
                    .foregroundStyle(PorcelainTokens.graphiteSecondary)
                    .lineLimit(1)
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
    GridItem(.flexible(), spacing: PorcelainTokens.Space.md),
    GridItem(.flexible(), spacing: PorcelainTokens.Space.md),
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
