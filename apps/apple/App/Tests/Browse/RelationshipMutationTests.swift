import CubbyKit
import Testing

@testable import Cubby

@MainActor
@Suite("Relationship mutation invalidation")
struct RelationshipMutationTests {
    @Test func expenseProjectInvalidatesExpenseAndProjectViews() {
        let model = PreviewFixtures.signedInModel()
        let recommendation = ActionableRelationshipRecommendation.expenseProject(
            .init(
                kind: .expenseProject,
                expenseId: "EXP-1001",
                target: .init(id: "PRJ-1001", name: "Workshop"),
                effectiveStart: nil,
                effectiveEnd: nil,
                sameTradeCount: 1,
                exactProductCount: 0,
                supportingExpenses: [],
                reasons: ["Same trade"]
            )
        )

        model.recordRelationshipMutation(
            RelationshipAcceptance(
                recommendation: recommendation,
                destination: recommendation.subject
            ))

        #expect(model.relationshipMutationRevision == 1)
        #expect(model.relationshipMutationEntities == [.expense, .project])
    }

    @Test func inventoryPlacementInvalidatesInventoryLocationAndProductViews() {
        let model = PreviewFixtures.signedInModel()
        let recommendation = ActionableRelationshipRecommendation.inventoryPlacement(
            .init(
                kind: .inventoryPlacement,
                inventoryId: InventoryEntryCode("INV-1001"),
                target: .init(id: LocationCode("LOC-1001"), name: "Pantry"),
                reasons: ["Only established stock location"]
            )
        )

        model.recordRelationshipMutation(
            RelationshipAcceptance(
                recommendation: recommendation,
                destination: recommendation.subject
            ))

        #expect(model.relationshipMutationRevision == 1)
        #expect(model.relationshipMutationEntities == [.inventory, .location, .product])
        #expect(model.relationshipMutationReplacement == nil)
    }

    @Test func mergedInventoryNavigatesToSurvivingRowAndStillInvalidatesLists() {
        let model = PreviewFixtures.signedInModel()
        model.navigator.section = .browse
        model.navigator.selectRecord(
            RecordSelection(key: .inventory, id: "INV-1001"),
            in: .browse
        )
        let recommendation = ActionableRelationshipRecommendation.inventoryPlacement(
            .init(
                kind: .inventoryPlacement,
                inventoryId: InventoryEntryCode("INV-1001"),
                target: .init(id: LocationCode("LOC-1001"), name: "Workshop"),
                reasons: ["Only established stock location"]
            )
        )
        let acceptance = RelationshipAcceptance(
            recommendation: recommendation,
            destination: .init(entity: .inventory, id: "INV-2002")
        )

        model.recordRelationshipMutation(acceptance)

        #expect(model.relationshipMutationRevision == 1)
        #expect(model.relationshipMutationEntities == [.inventory, .location, .product])
        #expect(model.relationshipMutationReplacement == acceptance)
        #if os(macOS)
            #expect(
                model.navigator.selectedRecords[.browse]
                    == RecordSelection(key: .inventory, id: "INV-2002"))
            #expect(model.navigator.paths[.browse]?.isEmpty != false)
        #else
            #expect(model.navigator.paths[.browse]?.last == .entityDetail(.inventory, id: "INV-2002"))
        #endif
    }
}
