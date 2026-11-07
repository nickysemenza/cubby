import CubbyKit
import Foundation

/// Synthetic Product, Expense and Task screens, decoded from the generated `entity.list` /
/// `entity.detail` fixtures (`apps/web/tooling/checks/apple-preview-fixtures.ts`) through
/// `EntityDescriptor.row(from:)`, exactly as the live reads. Rows also carry the server action
/// availability (`actions: [{id, enabled, reason}]`) ahead of its read contract.
///
/// - Product list: images and fallbacks, low and out of stock, needs data, placements, owners, a
///   long wrapping title, and an unavailable `recordSale`.
/// - Product detail: stocked-at relation rows, one pending brand Suggestion, unavailable
///   `recordSale`.
/// - Expense list: settled, unsettled, a refund, and rows borrowing their Product's thumbnail.
/// - Task list: overdue, due today, blocked, done, later; project, assignee and subject context.
///   Task detail has subtasks (one done) and a blocked dependent.
enum EntityScreenFixture: String, CaseIterable, Identifiable, Sendable {
    case product, expense, task

    var id: String { rawValue }

    var key: EntityKey {
        switch self {
        case .product: .product
        case .expense: .expense
        case .task: .task
        }
    }

    var descriptor: EntityDescriptor { EntityCatalog[key] }

    var listPage: ListPage<EntityRow> { PreviewFixtures.listPage("\(rawValue)List", key: key) }

    var detailRow: EntityRow {
        let raw: JSONValue = PreviewFixtures.screenFixture("\(rawValue)Detail")
        guard let row = descriptor.row(from: raw) else {
            fatalError("Preview fixture \(rawValue)Detail has no id")
        }
        return row
    }

    /// Relation rows keyed by declared detail section id; other relation sections render empty.
    var relationPages: [String: ListPage<EntityRow>] {
        switch self {
        case .product: ["stocked-at": PreviewFixtures.listPage("productStockedAt", key: .inventory)]
        case .expense: [:]
        case .task: ["subtasks": PreviewFixtures.listPage("taskSubtasks", key: .task)]
        }
    }
}

extension PreviewFixtures {
    /// The day the generator writes for "today" (`PREVIEW_TODAY`); rewritten to the render day so a
    /// due-today Task stays due today. Every other fixture date is absolute.
    nonisolated static let fixtureToday = "2026-09-14"

    /// A generated screen fixture with `fixtureToday` moved to the current local day.
    nonisolated static func screenFixture<T: Decodable>(_ name: String) -> T {
        guard let url = Bundle.main.url(forResource: name, withExtension: "json"),
            let data = try? Data(contentsOf: url),
            let text = String(data: data, encoding: .utf8)
        else { fatalError("Preview fixture \(name).json is missing; run pnpm generate") }
        let today = PlainDate(Date()).rawValue
        return decode(text.replacingOccurrences(of: fixtureToday, with: today))
    }

    private struct WirePage: Decodable {
        let items: [JSONValue]
        let meta: ListPageMeta
    }

    /// One generated `entity.list` page, as rows of `key`.
    static func listPage(_ name: String, key: EntityKey) -> ListPage<EntityRow> {
        let page: WirePage = screenFixture(name)
        return ListPage(items: page.items.compactMap { EntityCatalog[key].row(from: $0) }, meta: page.meta)
    }

    /// The Product detail's pending field Suggestions, the `suggestions.list` wire shape scoped to
    /// that record.
    static var productSuggestions: JSONValue { screenFixture("productSuggestions") }
}
