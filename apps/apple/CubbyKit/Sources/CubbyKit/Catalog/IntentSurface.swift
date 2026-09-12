/// Which catalog entities Siri, Shortcuts, Spotlight, and deep links expose: everything that can
/// be searched, fetched by id, and named by a shortcode. Nothing per-entity lives outside the
/// catalog, so adding an entity there adds it to every surface without Swift changes.
extension EntityDescriptor {
    public var isIntentExposed: Bool {
        shortcodePrefix != nil && actions.contains(.search) && actions.contains(.get)
    }
}

extension EntityCatalog {
    public static var intentExposed: [EntityDescriptor] {
        all.filter(\.isIntentExposed)
    }

    /// The descriptor whose shortcode prefix a code carries (`PRD-…` → product).
    public static func descriptor(forShortcode code: String) -> EntityDescriptor? {
        Shortcode.parse(code).map { self[$0.key] }
    }
}
