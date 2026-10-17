import CubbyKit
import SwiftUI

/// The pinned header of one grouped-list section: its label and its count over the whole
/// filtered set. When the grouped field declares a filter, tapping the header offers "Filter to
/// this" (keep only this section) and "Hide" (keep the grouping, drop this section).
struct EntityListSectionHeader: View {
    /// Each action is present only when the Group by choice's filter can express it.
    struct Actions {
        var filter: (() -> Void)?
        var hide: (() -> Void)?

        init(filter: (() -> Void)? = nil, hide: (() -> Void)? = nil) {
            self.filter = filter
            self.hide = hide
        }

        var isEmpty: Bool { filter == nil && hide == nil }
    }

    let section: EntityListSection
    let entity: EntityKey
    var actions = Actions()

    var body: some View {
        Group {
            if actions.isEmpty {
                label(actionable: false)
            } else {
                Menu {
                    if let filter = actions.filter {
                        Button("Filter to this", systemImage: "line.3.horizontal.decrease", action: filter)
                            .accessibilityIdentifier("browse.\(entity.rawValue).section.\(section.id).filter")
                    }
                    if let hide = actions.hide {
                        Button("Hide", systemImage: "eye.slash", action: hide)
                            .accessibilityIdentifier("browse.\(entity.rawValue).section.\(section.id).hide")
                    }
                } label: {
                    label(actionable: true)
                }
                .menuStyle(.button)
                .buttonStyle(.plain)
                .menuIndicator(.hidden)
                .accessibilityHint("Filters to or hides this \(section.label)")
            }
        }
        .accessibilityIdentifier("browse.\(entity.rawValue).section.\(section.id)")
    }

    private func label(actionable: Bool) -> some View {
        HStack(spacing: FieldGuideTokens.Space.sm) {
            Text(section.label)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.primary)
            Text(section.count.formatted())
                .font(.caption)
                .monospacedDigit()
                .foregroundStyle(.secondary)
            Spacer(minLength: 0)
            if actionable {
                Image(systemName: "ellipsis")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .accessibilityHidden(true)
            }
        }
        // A list section header dims its content's hierarchical styles, and a Menu label (unlike
        // a Button's) does not reset them; anchor the hierarchy so the label reads as primary.
        .foregroundStyle(Color.primary)
        .padding(.horizontal, FieldGuideTokens.Space.md)
        .padding(.vertical, FieldGuideTokens.Space.sm)
        .frame(maxWidth: .infinity, minHeight: FieldGuideTokens.touchTarget, alignment: .leading)
        .background(.bar)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

#Preview("Section header actions") {
    VStack(spacing: 0) {
        EntityListSectionHeader(
            section: EntityListSection(id: "PCT-OUTER", label: "Outerwear", count: 4, rows: []),
            entity: .inventory, actions: .init(filter: {}, hide: {}))
        EntityListSectionHeader(
            section: EntityListSection(
                id: EntityListSection.noValueKey, label: "No placement", count: 2, rows: []),
            entity: .inventory)
    }
}
