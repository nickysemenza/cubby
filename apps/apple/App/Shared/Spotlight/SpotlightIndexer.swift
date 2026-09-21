import CoreSpotlight
import CubbyKit
import Foundation

/// Publishes every intent-exposed entity to Spotlight so a product or bin can be found from the
/// home screen. Generic over the catalog; one table of per-kind list filters is the only
/// per-entity knowledge. Items open through the same `cubby://entity/<id>` path as deep links.
///
/// An actor, not a MainActor class: the refresh pages through every exposed entity right after
/// sign-in, and projecting thousands of rows into searchable items must not stall the UI.
actor SpotlightIndexer {
    static let refreshInterval: TimeInterval = 24 * 60 * 60
    static let pageSize = 200
    /// Per-kind cap; a kitchen has a few hundred products, not tens of thousands.
    static let maxPerKind = 2_000

    private var running = false

    private static func stampKey(_ host: String) -> String { "cubby.spotlight.refreshed.\(host)" }

    static func uniqueIdentifier(_ key: EntityKey, id: String) -> String { "\(key.rawValue)|\(id)" }

    /// The `(kind, id)` behind a Spotlight result's `CSSearchableItemActivityIdentifier`.
    static func link(from uniqueIdentifier: String) -> CubbyLink? {
        let parts = uniqueIdentifier.split(separator: "|", maxSplits: 1).map(String.init)
        guard parts.count == 2, let key = EntityKey(rawValue: parts[0]) else { return nil }
        return .entity(key, id: parts[1])
    }

    func refreshIfNeeded(client: CubbyClient, host: String, force: Bool = false) async {
        guard CSSearchableIndex.isIndexingAvailable(), !running else { return }
        let stamp = UserDefaults.standard.double(forKey: Self.stampKey(host))
        if !force, Date().timeIntervalSince1970 - stamp < Self.refreshInterval { return }
        running = true
        defer { running = false }
        let index = CSSearchableIndex.default()
        do {
            // Native actions include generic resources and explicitly enabled typed RPC reads.
            for descriptor in EntityCatalog.intentExposed where descriptor.key.nativeActions.contains(.list) {
                let items = try await Self.items(for: descriptor, client: client)
                try await index.deleteSearchableItems(withDomainIdentifiers: [
                    "cubby.\(descriptor.key.rawValue)"
                ])
                if !items.isEmpty { try await index.indexSearchableItems(items) }
            }
            UserDefaults.standard.set(Date().timeIntervalSince1970, forKey: Self.stampKey(host))
        } catch {
            // Spotlight is a convenience; a failed refresh retries on the next launch.
            Diagnostics.report(error, context: "spotlight.refresh")
        }
    }

    /// Drops every entry: on sign-out and when the base URL changes (another server's ids must
    /// never open against this one).
    func wipe() async {
        guard CSSearchableIndex.isIndexingAvailable() else { return }
        try? await CSSearchableIndex.default().deleteAllSearchableItems()
        for key in UserDefaults.standard.dictionaryRepresentation().keys
        where key.hasPrefix("cubby.spotlight.refreshed.") {
            UserDefaults.standard.removeObject(forKey: key)
        }
    }

    private static func items(for descriptor: EntityDescriptor, client: CubbyClient) async throws
        -> [CSSearchableItem]
    {
        var items: [CSSearchableItem] = []
        var page = 1
        while items.count < maxPerKind {
            // Only stocked products earn a Spotlight entry; everything else is indexed whole.
            let result =
                descriptor.key == .product
                ? try await client.stockedProducts(page: page, pageSize: pageSize)
                : try await client.list(descriptor, page: page, pageSize: pageSize)
            for row in result.items {
                let attributes = CSSearchableItemAttributeSet(contentType: .text)
                attributes.title = row.title
                attributes.contentDescription = row.subtitle ?? descriptor.singular.capitalized
                attributes.keywords = [descriptor.singular, descriptor.plural, row.id]
                attributes.thumbnailURL = row.imageURL
                items.append(
                    CSSearchableItem(
                        uniqueIdentifier: uniqueIdentifier(descriptor.key, id: row.id),
                        domainIdentifier: "cubby.\(descriptor.key.rawValue)",
                        attributeSet: attributes
                    )
                )
            }
            if result.items.count < pageSize || page * pageSize >= result.meta.totalCount { break }
            page += 1
        }
        return items
    }
}
