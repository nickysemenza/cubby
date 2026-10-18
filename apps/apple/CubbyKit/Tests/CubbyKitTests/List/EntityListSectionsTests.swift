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
                (key: "PCT-ALPHA", label: "Alpha", count: 2, subtree: true),
                (key: "PCT-BETA", label: "Beta", count: 3, subtree: false),
                (key: EntityListSection.noValueKey, label: "No category", count: 1, subtree: false),
            ])
        #expect(sections.map(\.id) == ["PCT-ALPHA", "PCT-BETA"])
        #expect(sections.map { $0.rows.map(\.title) } == [["Alpha one", "Alpha two"], ["Beta one"]])
        #expect(sections[1].count == 3)
        #expect(sections.map(\.subtree) == [true, false])
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

        // A level section holding its key's descendants keeps them in the filtered list.
        let tops = EntityListSection(id: "PCT-TOPS", label: "Tops", count: 3, subtree: true, rows: [])
        #expect(
            inventory.filtering(state, to: tops, of: category)
                == EntityFilterState([
                    "categoryFilter": ["PCT-TOPS"], "includeSubProductCategories": ["true"],
                ]))

        // Placement declares no No value filter, so its no-value section has no header action.
        let placement = try #require(inventory.groupChoice("placement"))
        #expect(inventory.filtering(state, to: none, of: placement) == nil)
    }

    // Hide keeps the grouping: the section's value joins the excluded values beside any include
    // values, a level section takes its descendants with it, and the no-value section narrows
    // presence rather than excluding.
    @Test func hidingASectionExcludesItsValue() throws {
        let category = try #require(inventory.groupChoice("category"))
        let state = EntityFilterState([
            "categoryFilter": ["PCT-CLOTHING"], "categoryExclude": ["PCT-SOCKS"],
            "includeSubProductCategories": ["false"],
        ])
        let outerwear = EntityListSection(id: "PCT-OUTER", label: "Outerwear", count: 2, rows: [])
        let hidden = try #require(inventory.hiding(state, section: outerwear, of: category))
        #expect(
            hidden
                == EntityFilterState([
                    "categoryFilter": ["PCT-CLOTHING"], "categoryExclude": ["PCT-SOCKS", "PCT-OUTER"],
                    "includeSubProductCategories": ["false"],
                ]))
        #expect(inventory.hiding(hidden, section: outerwear, of: category) == hidden)

        let level = EntityListSection(id: "PCT-OUTER", label: "Outerwear", count: 3, subtree: true, rows: [])
        #expect(
            inventory.hiding(state, section: level, of: category)
                == EntityFilterState([
                    "categoryFilter": ["PCT-CLOTHING"], "categoryExclude": ["PCT-SOCKS", "PCT-OUTER"],
                ]))

        let none = EntityListSection(
            id: EntityListSection.noValueKey, label: "No category", count: 1, rows: [])
        let picked = EntityFilterState([
            "categoryFilter": ["PCT-CLOTHING"], "categoryPresenceFilter": ["none"],
        ])
        #expect(
            inventory.hiding(picked, section: none, of: category)
                == EntityFilterState(["categoryFilter": ["PCT-CLOTHING"]]))
        #expect(
            inventory.hiding(EntityFilterState(), section: none, of: category)
                == EntityFilterState(["categoryPresenceFilter": ["has"]]))

        // Placement declares no No value, so its no-value section cannot hide.
        let placement = try #require(inventory.groupChoice("placement"))
        #expect(inventory.hiding(state, section: none, of: placement) == nil)
    }

    @Test func listInputCarriesTheGroupByChoice() throws {
        let input = try inventory.listInput(
            page: 1, pageSize: 20, sort: nil, filters: EntityFilterState(), groupBy: "category")
        #expect(input["groupBy"] == "category")
        #expect(input["groupLevel"] == nil)
        let leveled = try inventory.listInput(
            page: 1, pageSize: 20, sort: nil, filters: EntityFilterState(), groupBy: "category",
            groupLevel: 2)
        #expect(leveled["groupLevel"] == 2)

        // A hidden section reaches the kernel body as the exclude key's value list.
        let hidden = try inventory.listInput(
            page: 1, pageSize: 20, sort: nil,
            filters: EntityFilterState(["categoryExclude": ["PCT-OUTER", "PCT-SOCKS"]]), groupBy: "category")
        #expect(hidden["filters"]?["categoryExclude"] == ["PCT-OUTER", "PCT-SOCKS"])
    }

    // Levels come from the declaration: a related record whose entity nests offers them, a value
    // field says why it has none.
    @Test func groupingChoicesDeclareTheirLevels() throws {
        let category = try #require(inventory.groupChoice("category"))
        #expect(category.levels == 3)
        #expect(category.levelReason == nil)
        #expect(category.filter?.subtree == "includeSubProductCategories")
        let placement = try #require(inventory.groupChoice("placement"))
        #expect(placement.levels == 0)
        #expect(
            placement.levelReason
                == "Placement is a value, not a record with parents, so it has no levels.")
        let wardrobe = try #require(inventory.presentation.savedViews.first { $0.id == "wardrobe" })
        #expect(wardrobe.groupBy == "category")
        #expect(wardrobe.groupLevel == 2)
    }

    private static func row(_ title: String) -> EntityRow {
        EntityRow(id: "INV-\(title)", title: title, subtitle: nil, imageURL: nil, raw: .object([:]))
    }
}
