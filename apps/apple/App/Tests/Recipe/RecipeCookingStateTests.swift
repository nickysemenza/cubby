import CubbyKit
import Foundation
import Testing

@testable import Cubby

@MainActor
@Suite("Cooking position")
struct RecipeCookingStateTests {
    @Test func closingAndReopeningRestoresOnlyThatRecipesStep() throws {
        let cooking = RecipeCookingState()
        let plan = RecipeSlotPreviews.plan
        cooking.open(recipeID: "RCP-2345", plan: plan, factor: 2)
        let first = try #require(cooking.session)
        first.index = 1
        cooking.close()
        cooking.open(recipeID: "RCP-6789", plan: plan, factor: 1)
        #expect(cooking.session?.index == 0)
        cooking.open(recipeID: "RCP-2345", plan: plan, factor: 2)
        #expect(cooking.session?.index == 1)

        let shorter = try #require(
            RecipeCookPlan(
                recipe: .object([
                    "sections": .array([
                        .object([
                            "instructions": .array([.object(["instruction": .string("Stir.")])])
                        ])
                    ])
                ])))
        cooking.close()
        cooking.open(recipeID: "RCP-2345", plan: shorter, factor: 1)
        #expect(cooking.session?.index == 0)
        cooking.reset()
        cooking.open(recipeID: "RCP-2345", plan: plan, factor: 1)
        #expect(cooking.session?.index == 0)
    }

    @Test func handoffOpensTheTransferredRecipeAndStep() throws {
        let activity = NSUserActivity(activityType: RecipeCookHandoff.activityType)
        RecipeCookHandoff(recipeID: "RCP-2345", step: 1).update(activity, title: "Synthetic Tart")
        let transferred = try #require(RecipeCookHandoff(activity: activity))
        let cooking = RecipeCookingState()
        cooking.open(
            recipeID: transferred.recipeID, plan: RecipeSlotPreviews.plan, factor: 1,
            step: transferred.step)
        #expect(cooking.session?.recipeID == "RCP-2345")
        #expect(cooking.session?.index == 1)

        activity.userInfo = ["recipeID": "PRD-2345", "step": 1]
        #expect(RecipeCookHandoff(activity: activity) == nil)
    }
}
