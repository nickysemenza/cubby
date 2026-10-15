import Foundation

/// How a product's one stored `tags` list splits into compatibility Tags and Collections
/// (`collection:*` entries), and merges back: the rule web's `ProductTagsField` applies from
/// `@cubby/shared/collection-tag`. The prefix and slug pattern are generated from that module
/// (`SharedConstants`); `golden-vectors/collection-tag.json` pins the split, merge and slug
/// normalization on both clients.
public enum CollectionTag {
    public static func isCollectionTag(_ tag: String) -> Bool {
        slug(fromTag: tag) != nil
    }

    /// The slug of a valid `collection:<slug>` tag; nil for any other tag.
    public static func slug(fromTag tag: String) -> String? {
        let prefix = SharedConstants.collectionTagPrefix
        guard tag.hasPrefix(prefix) else { return nil }
        let slug = String(tag.dropFirst(prefix.count))
        guard let pattern = try? Regex(SharedConstants.collectionSlugPattern),
            slug.wholeMatch(of: pattern) != nil
        else { return nil }
        return slug
    }

    /// Lowercase ASCII letters and digits, any other run collapsed to one `-`, ends trimmed.
    public static func normalizedSlug(_ value: String) -> String {
        var slug = ""
        var pendingSeparator = false
        for scalar in value.lowercased().unicodeScalars {
            if ("a"..."z").contains(scalar) || ("0"..."9").contains(scalar) {
                if pendingSeparator && !slug.isEmpty { slug.append("-") }
                pendingSeparator = false
                slug.unicodeScalars.append(scalar)
            } else {
                pendingSeparator = true
            }
        }
        return slug
    }

    /// Compatibility tags (everything that is not a valid Collection tag, in order) and the
    /// distinct Collection slugs, sorted.
    public static func split(_ tags: [String]) -> (tags: [String], collections: [String]) {
        let collections = Set(tags.compactMap(slug(fromTag:))).sorted()
        return (tags.filter { !isCollectionTag($0) }, collections)
    }

    /// The stored list for edited Tags and Collections: collections normalized to slugs,
    /// deduplicated, and after the tags.
    public static func merge(tags: [String], collections: [String]) -> [String] {
        var seen = Set<String>()
        let slugs = collections.map(normalizedSlug).filter { !$0.isEmpty && seen.insert($0).inserted }
        return tags + slugs.map { SharedConstants.collectionTagPrefix + $0 }
    }
}
