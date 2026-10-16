import Foundation
import Testing

@testable import CubbyKit

@Suite("EntityListSections")
struct EntityListSectionsTests {
    private let inventory = EntityCatalog[.inventory]

    // The server keeps sections contiguous across pages, so each section takes its next `count`
    // loaded rows; a section none of whose rows has loaded yet is not shown.
    @Test func loadedRowsFillTheServerSectionsInOrder() {
        let sections = EntityListSection.sections(
            rows: ["Alpha one", "Alpha two", "Beta one"].map(Self.row),
            groups: [
                (key: "PCT-ALPHA", label: "Alpha", count: 2),
                (key: "PCT-BETA", label: "Beta", count: 3),
                (key: EntityListSection.noValueKey, label: "No category", count: 1),
            ])
        #expect(sections.map(\.id) == ["PCT-ALPHA", "PCT-BETA"])
        #expect(sections.map { $0.rows.map(\.title) } == [["Alpha one", "Alpha two"], ["Beta one"]])
        #expect(sections[1].count == 3)
    }

    @Test func filteringToASectionIncludesOnlyItsOwnValue() throws {
        let category = try #require(inventory.groupChoice("category"))
        var state = EntityFilterState()
        state.set(["has"], for: "categoryPresenceFilter")
        let section = EntityListSection(id: "PCT-TOPS", label: "Tops", count: 2, rows: [])
        let filtered = try #require(inventory.filtering(state, to: section, of: category))
        #expect(
            filtered
                == EntityFilterState([
                    "categoryFilter": ["PCT-TOPS"], "includeSubProductCategories": ["false"],
                ]))

        let none = EntityListSection(
            id: EntityListSection.noValueKey, label: "No category", count: 1, rows: [])
        #expect(
            inventory.filtering(filtered, to: none, of: category)
                == EntityFilterState(["categoryPresenceFilter": ["none"]]))

        // Placement declares no No value filter, so its no-value section has no header action.
        let placement = try #require(inventory.groupChoice("placement"))
        #expect(inventory.filtering(state, to: none, of: placement) == nil)
    }

    @Test func listInputCarriesTheGroupByChoice() throws {
        let input = try inventory.listInput(
            page: 1, pageSize: 20, sort: nil, filters: EntityFilterState(), groupBy: "category")
        #expect(input["groupBy"] == "category")
    }

    private static func row(_ title: String) -> EntityRow {
        EntityRow(id: "INV-\(title)", title: title, subtitle: nil, imageURL: nil, raw: .object([:]))
    }
}
