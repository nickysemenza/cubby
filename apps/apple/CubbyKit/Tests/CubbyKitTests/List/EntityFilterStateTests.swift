import Foundation
import Testing

@testable import CubbyKit

@Suite("EntityFilterState")
struct EntityFilterStateTests {
    /// An empty value is "no filter": it never counts toward the badge and never reaches a URL.
    @Test func settingAnEmptyValueRemovesTheParameter() {
        var state = EntityFilterState()
        state.set(["has"], for: "imagePresenceFilter")
        state.set(["a", "b"], for: "tagFilters")
        #expect(state.activeCount == 2)
        #expect(state.names == ["imagePresenceFilter", "tagFilters"])

        state.set([], for: "tagFilters")
        state.set([""], for: "imagePresenceFilter")
        #expect(state.isEmpty)
        #expect(EntityFilterState(["upcFilter": [""]]).isEmpty)
    }

    @Test func removeDropsOneParameterAndKeepsTheRest() {
        var state = EntityFilterState(["a": ["1"], "b": ["x"]])
        state.remove("a")
        #expect(state["a"] == nil)
        #expect(state["b"] == ["x"])
        #expect(state.activeCount == 1)
    }

    /// A link from a record to a filtered list names the declared URL key; the state carries the
    /// filter's wire parameter, and an undeclared key is dropped rather than sent.
    @Test func urlFiltersMapDeclaredKeysToWireNames() {
        let state = EntityFilterState(
            entity: .imageJob, urlFilters: ["imageId": "IMG-4K7M", "notAFilter": "x"])
        let wire = EntityCatalog[.imageJob].filters.first { $0.urlKey == "imageId" }?.wire.names.first
        #expect(wire != nil)
        #expect(state.activeCount == 1)
        #expect(state[wire ?? ""] == ["IMG-4K7M"])
    }

    /// A saved-view filter is `{id, values}` with no `isList`: every value is a list, and a single
    /// value travels as a one-element list.
    @Test func savedViewFiltersAreListsWithoutIsList() throws {
        let json = #"""
            {"id": "synthetic", "label": "Synthetic", "description": "", "sort": [],
             "columnVisibility": {},
             "filters": [{"id": "placementFilter", "values": ["stock"]},
                         {"id": "dataStatus", "values": ["needs_data", "defect"]}]}
            """#
        let view = try JSONDecoder().decode(SavedView.self, from: Data(json.utf8))
        #expect(
            view.filterState
                == EntityFilterState(["placementFilter": ["stock"], "dataStatus": ["needs_data", "defect"]]))
    }

    /// The presence, match and subtree parameters and the `@me` flag travel on each descriptor.
    @Test func filterDescriptorDecodesItsModeParameters() throws {
        let json = #"""
            {"columnId": "assigneeId", "urlKey": "assignee", "kind": "idMulti", "placeholder": "",
             "presenceParam": "assigneePresenceFilter", "matchParam": "assigneeMatch",
             "subtreeParam": "includeSubParties", "currentMember": true,
             "wire": {"param": {"name": "assigneeId"}}, "targetEntity": "ledgerParty"}
            """#
        let filter = try JSONDecoder().decode(FilterDescriptor.self, from: Data(json.utf8))
        #expect(filter.presenceParam == "assigneePresenceFilter")
        #expect(filter.matchParam == "assigneeMatch")
        #expect(filter.subtreeParam == "includeSubParties")
        #expect(filter.currentMember)
    }

    /// A list opens on a saved view's filters, else the route's, else the declared
    /// `initialFilters` (inventory opens on stock).
    @Test func listsOpenOnTheirInitialFiltersOnlyWithoutOthers() throws {
        let inventory = EntityCatalog[.inventory]
        let initial = EntityFilterState(filters: inventory.presentation.initialFilters)
        #expect(initial == EntityFilterState(["placementFilter": ["stock"]]))
        #expect(inventory.openingFilters(savedView: nil, explicit: EntityFilterState()) == initial)

        let explicit = EntityFilterState(["locationIdFilter": ["LOC-2345"]])
        #expect(inventory.openingFilters(savedView: nil, explicit: explicit) == explicit)

        let saved = try #require(inventory.presentation.savedViews.first)
        #expect(inventory.openingFilters(savedView: saved, explicit: explicit) == saved.filterState)
    }
}
