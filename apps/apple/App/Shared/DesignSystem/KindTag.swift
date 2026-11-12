import CubbyKit
import SwiftUI

/// What kind of record this is (`presentation.kind`), as a small tag with the option's glyph.
/// It names the kind; colour is not used.
struct KindTag: View {
    let option: LabeledOption

    var body: some View {
        HStack(spacing: 4) {
            if let symbol = option.glyph?.sfSymbol {
                Image(systemName: symbol).imageScale(.small).foregroundStyle(.secondary)
                    .accessibilityHidden(true)
            }
            Text(option.label)
        }
        .font(.caption.weight(.medium))
        .padding(.horizontal, 6)
        .padding(.vertical, 2)
        .background(RoundedRectangle(cornerRadius: FieldGuideTokens.radiusChip).fill(FieldGuideTokens.inset))
        .fixedSize()
    }
}

/// The kind option's declared explanation, folded behind one line: what it targets and leaves
/// out, its effects, dependencies, cost and recovery.
struct KindExplanation: View {
    let option: LabeledOption
    let explanation: OptionExplanation

    var body: some View {
        DisclosureGroup("About \(option.label)") {
            VStack(alignment: .leading, spacing: FieldGuideTokens.Space.sm) {
                fact("Works on", explanation.targets)
                fact("Leaves out", explanation.exclusions)
                fact("Effects", explanation.effects)
                fact("Needs", explanation.dependencies)
                fact("Cost", explanation.cost)
                fact("Recovery", explanation.recovery)
            }
            .padding(.top, FieldGuideTokens.Space.xs)
        }
        .font(.subheadline)
    }

    private func fact(_ label: String, _ text: String) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(label).font(.fieldGuideLabel).foregroundStyle(.secondary)
            Text(text).font(.subheadline).fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityElement(children: .combine)
    }
}

#Preview("Kind tag") {
    let option = try! JSONDecoder().decode(
        LabeledOption.self,
        from: Data(
            """
            {"value": "mail_import", "label": "Email import",
             "glyph": {"phosphor": "Receipt", "sfSymbol": "receipt"},
             "explanation": {"targets": "Order Emails from connected mailboxes.", "exclusions": "Unrelated mail.",
              "effects": "Imports purchases.", "dependencies": "A connected mailbox.", "cost": "AI calls per Email.",
              "recovery": "Retry the Run."}}
            """.utf8))
    List {
        KindTag(option: option)
        KindExplanation(option: option, explanation: option.explanation!)
    }
}
