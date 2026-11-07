import CubbyKit
import SwiftUI

/// The list's active filters as removable chips under search, one per "is" and "is not" side
/// (the same chips the filter sheet opens with). Removing a chip reloads the list without it.
struct EntityFilterChipBar: View {
    let descriptor: EntityDescriptor
    let filters: EntityFilterState
    let apply: (EntityFilterState) -> Void

    var body: some View {
        let chips = EntityFilterDraft.chips(in: descriptor, state: filters)
        if !chips.isEmpty {
            ScrollView(.horizontal) {
                HStack(spacing: FieldGuideTokens.Space.xs) {
                    ForEach(chips) { chip in
                        Button {
                            var draft = EntityFilterDraft(filters)
                            draft.remove(chip, in: descriptor)
                            apply(draft.state)
                        } label: {
                            HStack(spacing: FieldGuideTokens.Space.xs) {
                                Text(chip.label).lineLimit(1)
                                Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary)
                            }
                            .font(.footnote)
                            .padding(.horizontal, FieldGuideTokens.Space.sm)
                            .padding(.vertical, FieldGuideTokens.Space.xs)
                            .background(Capsule().fill(FieldGuideTokens.inset))
                            .overlay(Capsule().strokeBorder(FieldGuideTokens.hairline))
                            .frame(minHeight: FieldGuideTokens.touchTarget)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Remove filter \(chip.label)")
                        .accessibilityIdentifier("browse.\(descriptor.key.rawValue).chip.\(chip.id)")
                    }
                }
                .padding(.horizontal, FieldGuideTokens.Space.md)
            }
            .scrollIndicators(.hidden)
            .background(.background)
            .overlay(alignment: .bottom) { Divider() }
        }
    }
}

#Preview("Filter chips") {
    EntityFilterChipBar(descriptor: EntityCatalog[.task], filters: EntityFilterState()) { _ in }
}
