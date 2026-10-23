import CubbyKit
import SwiftUI

/// Presents server decisions; readiness and dependencies remain server-owned.
struct DecisionSteps<Media: View, StepBody: View>: View {
    let steps: [DecisionStep]
    @ViewBuilder let media: () -> Media
    @ViewBuilder let stepBody: (DecisionStep, @escaping () -> Void) -> StepBody

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    /// The status-mark column; the rail line runs through its center.
    @ScaledMetric(relativeTo: .caption) private var markWidth: CGFloat = 16
    @State private var openKey: String?
    @State private var collapsed = false
    @AccessibilityFocusState private var focusedStep: String?

    private var visibleSteps: [DecisionStep] { steps.filter { $0.key != "apply" } }
    private var effectiveKey: String? {
        guard !collapsed else { return nil }
        if let step = visibleSteps.first(where: { $0.key == openKey }), isEnabled(step) {
            return step.key
        }
        return visibleSteps.first { $0.status.rawValue == "needs_input" }?.key
    }

    var body: some View {
        ViewThatFits(in: .horizontal) {
            if !dynamicTypeSize.isAccessibilitySize {
                HStack(alignment: .top, spacing: FieldGuideTokens.Space.md) {
                    media().frame(width: 112)
                    // Side-by-side only when the ledger keeps room for wrapping summaries.
                    ledger.frame(minWidth: 440, maxWidth: .infinity)
                }
            }
            VStack(alignment: .leading, spacing: FieldGuideTokens.Space.md) {
                media()
                ledger
            }
        }
    }

    private var ledger: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(visibleSteps, id: \.key) { step in
                HStack(alignment: .top, spacing: FieldGuideTokens.Space.sm) {
                    mark(step)
                        .font(.caption)
                        .background { Circle().fill(Color("Canvas")) }
                        .frame(width: markWidth, height: rowHeight)
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 0) {
                        Button {
                            collapsed = effectiveKey == step.key
                            openKey = step.key
                            focusedStep = step.key
                        } label: {
                            HStack(spacing: FieldGuideTokens.Space.sm) {
                                if let action = step.action {
                                    Image(systemName: actionSymbol(action.rawValue))
                                        .foregroundStyle(actionColor(action.rawValue))
                                        .accessibilityHidden(true)
                                }
                                Text(step.label).fontWeight(.medium)
                                if let summary = step.summary, effectiveKey != step.key {
                                    Text(summary).foregroundStyle(.secondary)
                                }
                                Spacer(minLength: 0)
                                if isEnabled(step) {
                                    Text(step.status.rawValue == "done" ? "Change" : "Review")
                                        .font(.caption).foregroundStyle(.secondary)
                                }
                            }
                            .frame(minHeight: rowHeight, alignment: .leading)
                            .contentShape(.rect)
                        }
                        .buttonStyle(.plain)
                        .disabled(!isEnabled(step))
                        .accessibilityLabel(
                            "\(step.label), \(statusLabel(step)), \(step.summary ?? step.blockedReason ?? "")"
                        )
                        .accessibilityValue(effectiveKey == step.key ? "Expanded" : "Collapsed")
                        .accessibilityFocused($focusedStep, equals: step.key)
                        if effectiveKey == step.key {
                            stepBody(step) { advance(after: step.key) }
                                .padding(.bottom, FieldGuideTokens.Space.sm)
                        } else if let reason = step.blockedReason {
                            Text(reason).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
                .fixedSize(horizontal: false, vertical: true)
            }
        }
        .background(alignment: .leading) {
            Rectangle().fill(.quaternary).frame(width: 1)
                .padding(.leading, (markWidth - 1) / 2)
                .padding(.vertical, rowHeight / 2)
                .accessibilityHidden(true)
        }
    }

    private var rowHeight: CGFloat {
        #if os(macOS)
            dynamicTypeSize.isAccessibilitySize ? 44 : 28
        #else
            44
        #endif
    }

    private func isEnabled(_ step: DecisionStep) -> Bool {
        step.status.rawValue != "blocked" && step.status.rawValue != "not_needed"
    }

    private func advance(after key: String) {
        let remaining = visibleSteps.drop { $0.key != key }.dropFirst()
        openKey = remaining.first(where: isEnabled)?.key
        collapsed = openKey == nil
        focusedStep = openKey
    }

    private func statusLabel(_ step: DecisionStep) -> String {
        switch step.status.rawValue {
        case "done": "Done"
        case "needs_input": "Needs you"
        case "not_needed": "Not needed"
        default: "Blocked"
        }
    }

    /// Each status has its own glyph shape, so the mark never depends on color alone.
    @ViewBuilder private func mark(_ step: DecisionStep) -> some View {
        switch step.status.rawValue {
        case "done":
            Image(systemName: "checkmark.circle.fill").foregroundStyle(FieldGuideTokens.positive)
        case "needs_input":
            // Citron alone is too light for a glyph on the canvas; the dark mark carries contrast.
            Image(systemName: "exclamationmark.circle.fill")
                .symbolRenderingMode(.palette)
                .foregroundStyle(Color.black, FieldGuideTokens.signal)
        case "not_needed":
            Image(systemName: "minus.circle").foregroundStyle(.secondary)
        default:
            Image(systemName: "circle.dashed").foregroundStyle(.secondary)
        }
    }

    private func actionColor(_ action: String) -> Color {
        switch action {
        case "create": Color("ActionCreate")
        case "change": Color("ActionChange")
        case "remove": FieldGuideTokens.destructive
        default: Color("Slate")
        }
    }

    private func actionSymbol(_ action: String) -> String {
        switch action {
        case "create": "plus"
        case "link": "arrow.turn.down.right"
        case "change": "pencil"
        default: "minus"
        }
    }
}

#if DEBUG
    #Preview("Decision steps") {
        DecisionSteps(
            steps: [
                .init(
                    key: "product", label: "Product", status: .done, summary: "Synthetic shirt", action: nil,
                    blockedReason: nil),
                .init(
                    key: "identity", label: "Right one?", status: .needsInput, summary: nil, action: nil,
                    blockedReason: nil),
                .init(
                    key: "ownership", label: "Whose is it?", status: .notNeeded, summary: nil, action: nil,
                    blockedReason: nil),
                .init(
                    key: "inventory", label: "Where is it?", status: .blocked, summary: nil, action: nil,
                    blockedReason: nil),
            ],
            media: { Image(systemName: "tshirt").font(.largeTitle) },
            stepBody: { _, next in Button("Yes, this is it", action: next) }
        )
        .padding(FieldGuideTokens.Space.md)
    }
#endif
