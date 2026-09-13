import AppIntents
import CubbyKit
import Foundation

// Intent structs keep the app's MainActor default because `@Parameter` expands to stored `var`s,
// which cannot be nonisolated; `perform()` is async, so an isolated witness satisfies the
// nonisolated requirement, and the sync statics AppIntents reads off-main are marked
// nonisolated one by one.

/// "Find <kind> matching <text>" — the one search intent every catalog entity shares.
struct FindEntityIntent: AppIntent {
    static let title: LocalizedStringResource = "Find in Cubby"
    static let description = IntentDescription(
        "Searches products, locations, recipes, and everything else in Cubby.")
    static let supportedModes: IntentModes = .background

    @Parameter(title: "Search for")
    var query: String

    @Parameter(title: "Kind")
    var kind: CubbyKind?

    nonisolated static var parameterSummary: some ParameterSummary {
        Summary("Find \(\.$query) in Cubby") {
            \.$kind
        }
    }

    func perform() async throws -> some ReturnsValue<[CubbyEntity]> & ProvidesDialog {
        let client = try await IntentContext.client()
        let kinds = kind?.key.map { [$0] }
        let hits = try await client.search(query, kinds: kinds, limit: 10).compactMap(CubbyEntity.init(hit:))
        if let first = hits.first { RecentEntities.record(first.id) }
        let dialog: IntentDialog =
            hits.isEmpty
            ? "Nothing in Cubby matches \(query)."
            : "Found \(hits.count) — first is \(hits[0].title)."
        return .result(value: hits, dialog: dialog)
    }
}

/// "Where is my <product>?" — answers from the product's stocked-at relation.
struct WhereIsProductIntent: AppIntent {
    static let title: LocalizedStringResource = "Where Is a Product"
    static let description = IntentDescription("Says which location a product is stocked in.")
    static let supportedModes: IntentModes = .background

    @Parameter(title: "Product")
    var product: String

    nonisolated static var parameterSummary: some ParameterSummary {
        Summary("Where is \(\.$product)")
    }

    func perform() async throws -> some ProvidesDialog {
        let client = try await IntentContext.client()
        guard let hit = try await client.search(product, kinds: [.product], limit: 1).first else {
            return .result(dialog: "No product in Cubby matches \(product).")
        }
        RecentEntities.record(hit.id)
        let descriptor = EntityCatalog[.product]
        guard let row = try await client.row(descriptor, id: hit.id) else {
            throw IntentContext.Failure.notFound("product \(hit.id)")
        }
        let stocked = ProductRelations.stockedAt(from: row).filter { $0.placement != "installed" }
        guard !stocked.isEmpty else {
            return .result(dialog: "\(row.title) isn't stocked anywhere.")
        }
        let places = stocked.prefix(3).map { place in
            let path = place.ancestorPath.map { " (\($0))" } ?? ""
            let amount = place.amount.map { " — \(Self.format($0))" } ?? ""
            return "\(place.locationName)\(path)\(amount)"
        }
        let more = stocked.count > 3 ? " and \(stocked.count - 3) more" : ""
        return .result(dialog: "\(row.title) is in \(places.joined(separator: "; "))\(more).")
    }

    private static func format(_ amount: Amount) -> String {
        let value = amount.value == amount.value.rounded() ? String(Int(amount.value)) : String(amount.value)
        return "\(value) \(amount.unit)"
    }
}

/// Opens any entity in the app.
struct OpenEntityIntent: AppIntent {
    static let title: LocalizedStringResource = "Open in Cubby"
    static let description = IntentDescription(
        "Opens a product, location, recipe, or anything else in Cubby.")
    static let supportedModes: IntentModes = .foreground(.immediate)

    @Parameter(title: "Item")
    var entity: CubbyEntity

    nonisolated static var parameterSummary: some ParameterSummary {
        Summary("Open \(\.$entity)")
    }

    func perform() async throws -> some IntentResult {
        RecentEntities.record(entity.id)
        await IntentContext.open(entity.link)
        return .result()
    }
}

/// Starts a walk-the-shelf recount, optionally scoped to a location.
struct StartAuditIntent: AppIntent {
    static let title: LocalizedStringResource = "Walk the Shelf"
    static let description = IntentDescription("Starts a recount of every stocked bin under a location.")
    static let supportedModes: IntentModes = .foreground(.immediate)

    @Parameter(title: "Location")
    var location: CubbyEntity?

    nonisolated static var parameterSummary: some ParameterSummary {
        Summary("Walk the shelf at \(\.$location)")
    }

    func perform() async throws -> some IntentResult {
        let scope = location.flatMap { $0.kind == .location ? LocationCode($0.id) : nil }
        await IntentContext.open(.audit(location: scope))
        return .result()
    }
}

/// Scans one code at a location without opening the app: the same server call as Capture.
struct ScanCodeIntent: AppIntent {
    static let title: LocalizedStringResource = "Scan Into Location"
    static let description = IntentDescription("Records a barcode, ISBN, or product label at a location.")
    static let supportedModes: IntentModes = .background

    @Parameter(title: "Code")
    var code: String

    @Parameter(title: "Location")
    var location: CubbyEntity

    nonisolated static var parameterSummary: some ParameterSummary {
        Summary("Scan \(\.$code) into \(\.$location)")
    }

    func perform() async throws -> some ProvidesDialog {
        guard location.kind == .location else {
            return .result(dialog: "\(location.title) is not a location.")
        }
        let scanCode: ScanCode
        switch ScanCode.classify(code) {
        case .success(let classified): scanCode = classified
        case .failure(let error): return .result(dialog: "\(error.message)")
        }
        let client = try await IntentContext.client()
        let result = try await client.scan(scanCode, at: LocationCode(location.id))
        RecentEntities.record(location.id)
        let dialog: IntentDialog
        switch result.outcome {
        case .added: dialog = "Added \(result.product.name) to \(location.title)."
        case .confirmed: dialog = "\(result.product.name) is already in \(location.title)."
        case .queued: dialog = "\(result.product.name) is stocked elsewhere; open Cubby to move it."
        }
        return .result(dialog: dialog)
    }
}

/// Resolves a scanned or spoken code the same way Search's field does: a Cubby label or barcode
/// opens directly, several matches or an unrecognized code fall through to Search with the code
/// prefilled rather than guessing.
struct LookUpCodeIntent: AppIntent {
    static let title: LocalizedStringResource = "Look Up a Code"
    static let description = IntentDescription(
        "Resolves a barcode, ISBN, or Cubby label and opens what it finds.")
    static let supportedModes: IntentModes = .foreground(.immediate)

    @Parameter(title: "Code")
    var code: String

    nonisolated static var parameterSummary: some ParameterSummary {
        Summary("Look up \(\.$code)")
    }

    func perform() async throws -> some IntentResult {
        let client = try await IntentContext.client()
        let outcome = try await CodeLookup(service: client).resolve(code)
        switch outcome {
        case .link(let link):
            await IntentContext.open(link)
        case .products(let rows, _) where rows.count == 1:
            if let row = rows.first {
                RecentEntities.record(row.id)
                await IntentContext.open(.entity(.product, id: row.id))
            }
        case .products, .unknownCode, .text:
            await IntentContext.openSearch(prefilling: code)
        }
        return .result()
    }
}

nonisolated struct CubbyShortcuts: AppShortcutsProvider {
    static let shortcutTileColor: ShortcutTileColor = .navy

    /// Phrases Siri must not route here: "where is my phone" is Find My, not a product lookup.
    static var negativePhrases: NegativeAppShortcutPhrases {
        NegativeAppShortcutPhrases(phrases: [
            "Where is my phone", "Where is my iPhone", "Find my iPhone", "Find my phone",
        ])
    }

    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: WhereIsProductIntent(),
            // A phrase may only embed AppEntity/AppEnum parameters, so the product name is asked for.
            phrases: [
                "Where is something in \(.applicationName)",
                "Ask \(.applicationName) where something is",
            ],
            shortTitle: "Where is",
            systemImageName: "location.magnifyingglass"
        )
        AppShortcut(
            intent: FindEntityIntent(),
            phrases: ["Find something in \(.applicationName)", "Search \(.applicationName)"],
            shortTitle: "Find",
            systemImageName: "magnifyingglass"
        )
        AppShortcut(
            intent: StartAuditIntent(),
            phrases: ["Walk the shelf in \(.applicationName)", "Start a recount in \(.applicationName)"],
            shortTitle: "Walk the shelf",
            systemImageName: "checklist"
        )
        AppShortcut(
            intent: ScanCodeIntent(),
            phrases: ["Scan into \(.applicationName)"],
            shortTitle: "Scan",
            systemImageName: "barcode.viewfinder"
        )
        AppShortcut(
            intent: LookUpCodeIntent(),
            phrases: ["Look up a code in \(.applicationName)"],
            shortTitle: "Look up",
            systemImageName: "number.square"
        )
    }
}
