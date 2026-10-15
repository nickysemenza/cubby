import Testing

@testable import CubbyKit

@Suite("EntityFilterState")
struct EntityFilterStateTests {
    /// An empty value is "no filter": it never counts toward the badge and never reaches a URL.
    @Test func settingAnEmptyValueRemovesTheParameter() {
        var state = EntityFilterState()
        state.set(.single("has"), for: "imagePresenceFilter")
        state.set(.many(["a", "b"]), for: "tagFilters")
        #expect(state.activeCount == 2)
        #expect(state.names == ["imagePresenceFilter", "tagFilters"])

        state.set(.many([]), for: "tagFilters")
        state.set(.single(""), for: "imagePresenceFilter")
        #expect(state.isEmpty)
        #expect(EntityFilterState(["upcFilter": .single("")]).isEmpty)
    }

    @Test func removeDropsOneParameterAndKeepsTheRest() {
        var state = EntityFilterState(["a": .single("1"), "b": .many(["x"])])
        state.remove("a")
        #expect(state["a"] == nil)
        #expect(state["b"] == .many(["x"]))
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
        #expect(state[wire ?? ""] == .single("IMG-4K7M"))
    }
}
