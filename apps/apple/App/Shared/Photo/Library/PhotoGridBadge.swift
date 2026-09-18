import Foundation

/// The small ownership label shown in the Photos grid.
///
/// Selection order is rendered by the cell before this label. Ownership is
/// deliberately a display-only concern: it never changes the selected photo
/// or the importer destination.
enum PhotoGridBadge {
    static func text(for directOwnerShortcodes: [String]) -> String? {
        let owners = Set(directOwnerShortcodes.filter { !$0.isEmpty }).sorted()
        guard let primary = owners.first else { return nil }
        return owners.count == 1 ? primary : "\(primary)+\(owners.count - 1)"
    }

    static func accessibilityDescription(for directOwnerShortcodes: [String]) -> String? {
        guard let text = text(for: directOwnerShortcodes) else { return nil }
        return "Owned by \(text)"
    }
}
