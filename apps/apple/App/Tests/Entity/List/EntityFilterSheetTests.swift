import CubbyKit
import Testing

@testable import Cubby

/// `EntityFilterDraft` is the sheet's mapping from a descriptor's control value to the wire
/// parameters `EntityFilterState` carries; a wrong wire name here silently filters nothing.
@Suite("Entity filter sheet mapping")
struct EntityFilterSheetTests {
    private let inventory = EntityCatalog[.inventory]

    @Test func eachKindWritesItsWireParameters() throws {
        var draft = EntityFilterDraft()

        let text = try #require(inventory.filter("product"))
        draft.setSingle("skillet", for: text)
        #expect(draft.state["productNameFilter"] == .single("skillet"))

        let multi = try #require(inventory.filter("category"))
        draft.setMany(["CAT-2345", "CAT-6789"], for: multi)
        #expect(draft.state["categoryFilter"] == .many(["CAT-2345", "CAT-6789"]))
        #expect(draft.many(multi) == ["CAT-2345", "CAT-6789"])

        let id = try #require(inventory.filter("productId"))
        draft.setSingle("PRD-1", for: id)
        #expect(draft.state["productIdFilter"] == .single("PRD-1"))

        let presence = try #require(inventory.filter("ingredientPresenceFilter"))
        draft.setSingle("has", for: presence)
        #expect(draft.state["ingredientPresenceFilter"] == .single("has"))

        let range = try #require(inventory.filter("verifiedAt"))
        draft.setRange(.init(from: "2026-01-01", to: "", presence: "none"), for: range)
        #expect(draft.state["verifiedFrom"] == .single("2026-01-01"))
        #expect(draft.state["verifiedTo"] == nil)
        #expect(draft.state["verifiedPresenceFilter"] == .single("none"))
        #expect(draft.range(range) == .init(from: "2026-01-01", to: "", presence: "none"))
        #expect(draft.isActive(range))

        draft.clear(range)
        #expect(!draft.isActive(range))
        #expect(draft.state.activeCount == 4)
    }

    /// The Owner filter offers Me plus its declared sentinels, sent unbranded and kept apart
    /// from the picked record codes.
    @Test func ownerFilterOffersSentinelsBesideMe() throws {
        let owner = try #require(inventory.filters.first { $0.sentinels != nil })
        let tokens = EntityFilterDraft.tokens(owner)
        #expect(tokens.map(\.value) == ["@me", "@household", "@unknown"])
        #expect(EntityFilterDraft.displayName(forFilterValue: "@household", in: owner) == "Household")

        var draft = EntityFilterDraft()
        draft.setMany(["LPY-4K7M"], for: owner)
        draft.set("@household", true, for: owner)
        #expect(draft.many(owner) == ["@household", "LPY-4K7M"])
        #expect(draft.selects("@household", in: owner))
        draft.set("@household", false, for: owner)
        #expect(draft.many(owner) == ["LPY-4K7M"])
    }

    /// An emptied control removes its parameter rather than sending an empty value.
    @Test func emptyValueRemovesTheParameter() throws {
        var draft = EntityFilterDraft(EntityFilterState(["productNameFilter": .single("x")]))
        let text = try #require(inventory.filter("product"))
        draft.setSingle("", for: text)
        #expect(draft.state.isEmpty)
    }

    /// A range over a timestamp column edits dates; `verifiedAt` has no catalog field, so the
    /// column name decides.
    @Test func rangeKindFollowsTheColumnField() throws {
        let created = try #require(inventory.filter("createdAt"))
        #expect(EntityFilterDraft.rangeIsDates(created, in: inventory))
        let verified = try #require(inventory.filter("verifiedAt"))
        #expect(EntityFilterDraft.rangeIsDates(verified, in: inventory))
    }

    /// A select without declared options takes the list route's enum values.
    @Test func optionsFallBackToTheRouteEnum() throws {
        let expense = EntityCatalog[.expense]
        let costType = try #require(expense.filter("costType"))
        let options = EntityFilterDraft.options(for: costType, in: expense)
        #expect(options.map(\.value).contains("materials"))
    }
}
