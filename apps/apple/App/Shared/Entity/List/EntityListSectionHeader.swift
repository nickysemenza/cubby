import CubbyKit
import SwiftUI

/// The pinned header of one grouped-list section: its label and its count over the whole
/// filtered set. When the grouped field declares a filter, tapping the header filters the list
/// to that section's value.
struct EntityListSectionHeader: View {
    let section: EntityListSection
    let entity: EntityKey
    /// Present only when the Group by choice declares a filter for this section's value.
    var onFilter: (() -> Void)?

    var body: some View {
        Group {
            if let onFilter {
                Button(action: onFilter) { label(filterable: true) }
                    .buttonStyle(.plain)
                    .accessibilityHint("Filters to this \(section.label)")
            } else {
                label(filterable: false)
            }
        }
        .accessibilityIdentifier("browse.\(entity.rawValue).section.\(section.id)")
    }

    private func label(filterable: Bool) -> some View {
        HStack(spacing: FieldGuideTokens.Space.sm) {
            Text(section.label)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.primary)
            Text(section.count.formatted())
                .font(.caption)
                .monospacedDigit()
                .foregroundStyle(.secondary)
            Spacer(minLength: 0)
            if filterable {
                Image(systemName: "line.3.horizontal.decrease")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .accessibilityHidden(true)
            }
        }
        .padding(.horizontal, FieldGuideTokens.Space.md)
        .padding(.vertical, FieldGuideTokens.Space.sm)
        .frame(maxWidth: .infinity, minHeight: FieldGuideTokens.touchTarget, alignment: .leading)
        .background(.bar)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}
