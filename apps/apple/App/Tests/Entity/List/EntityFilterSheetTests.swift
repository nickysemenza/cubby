import CubbyKit
import Foundation
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
        draft.setValue("skillet", for: text)
        #expect(draft.state["productNameFilter"] == ["skillet"])

        let multi = try #require(inventory.filter("category"))
        draft.setValues(["CAT-2345", "CAT-6789"], for: multi)
        #expect(draft.state["categoryFilter"] == ["CAT-2345", "CAT-6789"])
        #expect(draft.values(multi) == ["CAT-2345", "CAT-6789"])

        let presence = try #require(inventory.filter("ingredientPresenceFilter"))
        draft.setValue("has", for: presence)
        #expect(draft.state["ingredientPresenceFilter"] == ["has"])

        let range = try #require(inventory.filter("verifiedAt"))
        draft.setRange(.init(from: "2026-01-01", to: "", presence: "none"), for: range)
        #expect(draft.state["verifiedFrom"] == ["2026-01-01"])
        #expect(draft.state["verifiedTo"] == nil)
        #expect(draft.state["verifiedPresenceFilter"] == ["none"])
        #expect(draft.range(range) == .init(from: "2026-01-01", to: "", presence: "none"))
        #expect(draft.isActive(range))

        draft.clear(range)
        #expect(!draft.isActive(range))
        #expect(draft.state.activeCount == 3)
    }

    /// A former single-select (placement, data status) is any-of: a second pick adds to the list.
    @Test func formerSingleSelectsTakeSeveralValues() throws {
        var draft = EntityFilterDraft()
        let placement = try #require(inventory.filter("placement"))
        #expect(placement.kind == .multiselect)
        draft.set("stock", true, for: placement)
        draft.set("installed", true, for: placement)
        #expect(Set(try #require(draft.state["placementFilter"])) == ["stock", "installed"])

        let status = try #require(inventory.filter("dataQuality"))
        draft.set("needs_data", true, for: status)
        draft.set("defect", true, for: status)
        #expect(Set(try #require(draft.state["dataStatus"])) == ["needs_data", "defect"])
    }

    /// Any value already includes every value, so it clears the picks; a pick clears Any value.
    /// No value combines with picks ("A or no value").
    @Test func anyValueAndNoValueFollowThePresenceRule() throws {
        let category = try #require(inventory.filter("category"))
        let presence = try #require(category.presenceParam)
        var draft = EntityFilterDraft()

        draft.setValues(["CAT-2345"], for: category)
        draft.setAnyValue(true, for: category)
        #expect(draft.state["categoryFilter"] == nil)
        #expect(draft.state[presence] == ["has"])

        draft.set("CAT-6789", true, for: category)
        #expect(draft.state[presence] == nil)
        #expect(draft.state["categoryFilter"] == ["CAT-6789"])

        draft.setNoValue(true, for: category)
        #expect(draft.state[presence] == ["none"])
        #expect(draft.state["categoryFilter"] == ["CAT-6789"])

        draft.clear(category)
        #expect(draft.state.isEmpty)
    }

    /// Match all is offered only where declared and writes `all`; Match any removes it.
    @Test func matchAllWritesTheMatchParameter() throws {
        let tags = try #require(EntityCatalog[.product].filter("tags"))
        let match = try #require(tags.matchParam)
        var draft = EntityFilterDraft()
        draft.setMatchesAll(true, for: tags)
        #expect(draft.state[match] == ["all"])
        #expect(draft.matchesAll(tags))
        draft.setMatchesAll(false, for: tags)
        #expect(draft.state[match] == nil)
    }

    /// Include sub-‹entity› is on by default: off sends "false", on removes the parameter, and
    /// the toggle's own descriptor never renders as a second section.
    @Test func subtreeToggleSendsOnlyFalse() throws {
        let category = try #require(inventory.filter("category"))
        let subtree = try #require(category.subtreeParam)
        var draft = EntityFilterDraft()
        #expect(draft.includesSubtree(category))
        draft.setIncludesSubtree(false, for: category)
        #expect(draft.state[subtree] == ["false"])
        draft.setIncludesSubtree(true, for: category)
        #expect(draft.state[subtree] == nil)

        let sections = EntityFilterDraft.sections(of: inventory).flatMap(\.wire.names)
        #expect(!sections.contains(subtree))
        #expect(sections.contains("categoryFilter"))
    }

    /// "Me" comes from the descriptor's `currentMember`, not its target entity; the Owner filter
    /// adds its declared sentinels, sent unbranded and kept apart from picked record codes.
    @Test func meFollowsCurrentMemberBesideSentinels() throws {
        let owner = try #require(inventory.filters.first { $0.sentinels != nil })
        let tokens = EntityFilterDraft.tokens(owner)
        #expect(tokens.map(\.value) == ["@me", "@household", "@unknown"])
        #expect(EntityFilterDraft.displayName(forFilterValue: "@household", in: owner) == "Household")

        let json = #"""
            {"columnId": "payerId", "urlKey": "payer", "kind": "idMulti", "placeholder": "",
             "currentMember": false, "wire": {"param": {"name": "payerId"}}, "targetEntity": "ledgerParty"}
            """#
        let party = try JSONDecoder().decode(FilterDescriptor.self, from: Data(json.utf8))
        #expect(EntityFilterDraft.tokens(party).isEmpty)

        var draft = EntityFilterDraft()
        draft.setValues(["LPY-4K7M"], for: owner)
        draft.set("@household", true, for: owner)
        #expect(draft.values(owner) == ["@household", "LPY-4K7M"])
        #expect(draft.selects("@household", in: owner))
        draft.set("@household", false, for: owner)
        #expect(draft.values(owner) == ["LPY-4K7M"])
    }

    /// An emptied control removes its parameter rather than sending an empty value.
    @Test func emptyValueRemovesTheParameter() throws {
        var draft = EntityFilterDraft(EntityFilterState(["productNameFilter": ["x"]]))
        let text = try #require(inventory.filter("product"))
        draft.setValue("", for: text)
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

    /// A multiselect without declared options takes the list route's enum values.
    @Test func optionsFallBackToTheRouteEnum() throws {
        let expense = EntityCatalog[.expense]
        let costType = try #require(expense.filter("costType"))
        let options = EntityFilterDraft.options(for: costType, in: expense)
        #expect(options.map(\.value).contains("materials"))
    }
}
