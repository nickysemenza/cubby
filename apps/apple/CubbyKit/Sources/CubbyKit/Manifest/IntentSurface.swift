/// Which catalog entities Siri, Shortcuts, Spotlight, and deep links expose: everything the
/// server indexes for search, the generated native client fetches by id, and names by a shortcode. Nothing
/// per-entity lives outside the catalog, so adding an entity there adds it to every surface
/// without Swift changes.
extension EntityDescriptor {
    public var isIntentExposed: Bool {
        shortcodePrefix != nil && searchable && key.nativeActions.contains(.get)
    }
}

extension EntityCatalog {
    public static var intentExposed: [EntityDescriptor] {
        all.filter(\.isIntentExposed)
    }
}
