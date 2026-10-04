import Testing

@testable import CubbyKit

/// Failure modes this guards: Swift re-implementing the scale rule (a 9-inch pan doubling), an
/// anchor compounding on the displayed amount, a recipe with no instructions producing an empty
/// cook mode, and a scaled yield printing float noise. The arithmetic itself is Rust, pinned in
/// recipebridge; these tests prove the FFI is wired to it and the plan feeds it.
@Suite("RecipeCookPlan and RecipeScaling (Rust via UniFFI)")
struct RecipeCookPlanTests {
    private func amount(_ value: Double, _ unit: String, upper: Double? = nil) -> JSONValue {
        var object: [String: JSONValue] = ["value": .number(value), "unit": .string(unit)]
        if let upper { object["upperValue"] = .number(upper) }
        return .object(object)
    }

    private func line(_ name: String, amounts: [JSONValue], modifier: String? = nil) -> JSONValue {
        .object([
            "type": .string("ingredient"),
            "amounts": .array(amounts),
            "modifier": modifier.map(JSONValue.string) ?? .null,
            "ingredient": .object(["name": .string(name)]),
        ])
    }

    private func recipe() -> JSONValue {
        .object([
            "name": .string("Synthetic Tart"),
            "yield": .object(["value": .number(4), "unit": .string("serving")]),
            "servings": .number(4),
            "sections": .array([
                .object([
                    "name": .string("Crust"),
                    "ingredients": .array([
                        line("flour", amounts: [amount(2, "cup"), amount(250, "g")], modifier: "sifted"),
                        line("pan", amounts: [amount(9, "inch")]),
                    ]),
                    "instructions": .array([
                        .object(["instruction": .string("Mix the dough.")]),
                        .object(["instruction": .string("Chill it.")]),
                    ]),
                ]),
                .object([
                    "name": .null,
                    "ingredients": .array([line("butter", amounts: [amount(1, "tbsp", upper: 2)])]),
                    "instructions": .array([.object(["instruction": .string("Bake.")])]),
                ]),
            ]),
        ])
    }

    @Test func flattensInstructionsIntoOrderedSteps() throws {
        let plan = try #require(RecipeCookPlan(recipe: recipe()))
        #expect(plan.steps.map(\.text) == ["Mix the dough.", "Chill it.", "Bake."])
        #expect(plan.steps.map(\.sectionIndex) == [0, 0, 1])
        #expect(plan.steps.map(\.numberInSection) == [1, 2, 1])
        #expect(plan.steps[0].sectionName == "Crust")
        #expect(plan.steps[2].sectionName == nil)
    }

    @Test func scalesAmountsThroughRustAndLeavesAPanAlone() throws {
        let plan = try #require(RecipeCookPlan(recipe: recipe()))
        let crust = plan.sections[0].ingredients
        #expect(plan.line(crust[0], factor: 1) == "2 cups (250 g) flour, sifted")
        #expect(plan.line(crust[0], factor: 2) == "4 cups (500 g) flour, sifted")
        #expect(plan.line(crust[1], factor: 2) == "9 \" pan")
    }

    @Test func scalesBothEndsOfARange() throws {
        let plan = try #require(RecipeCookPlan(recipe: recipe()))
        #expect(plan.line(plan.sections[1].ingredients[0], factor: 3).hasPrefix("3 - 6 tbsp"))
    }

    @Test func labelsTheScaledYieldAndServings() throws {
        let plan = try #require(RecipeCookPlan(recipe: recipe()))
        #expect(plan.yieldLabel(factor: 1.5) == "6 serving")
        #expect(plan.servings(factor: 1.5) == 6)
        #expect(plan.yieldLabel(factor: 1.0 / 3.0) == "1.33 serving")
    }

    @Test func aRecipeWithoutInstructionsHasNoSteps() throws {
        let bare: JSONValue = .object([
            "name": .string("Bare"),
            "sections": .array([
                .object([
                    "name": .null, "ingredients": .array([line("salt", amounts: [amount(1, "tsp")])]),
                    "instructions": .array([]),
                ])
            ]),
        ])
        let plan = try #require(RecipeCookPlan(recipe: bare))
        #expect(plan.steps.isEmpty)
        #expect(plan.sections.count == 1)
    }

    @Test func aRowWithoutSectionsIsNotAPlan() {
        #expect(RecipeCookPlan(recipe: .object(["name": .string("Empty")])) == nil)
    }

    @Test func anchorsAreResolvedByRust() {
        #expect(RecipeScaling.clamp(0) == 1)
        #expect(RecipeScaling.clamp(0.001) == 0.01)
        #expect(RecipeScaling.factor(original: 2, setTo: 3) == 1.5)
        // No original amount to anchor on leaves the recipe unscaled.
        #expect(RecipeScaling.factor(original: 0, setTo: 3) == 1)
    }

    @Test func aTotalWeightTargetIsMeasuredAgainstTheUnscaledRecipe() {
        // Shown at 2x and weighing 800 g, the original is 400 g: 600 g is 1.5x, not 0.75x.
        #expect(RecipeScaling.factor(forTotalWeight: 600, scaledWeight: 800, currentFactor: 2) == 1.5)
        // Without a known weight there is nothing to anchor on.
        #expect(RecipeScaling.factor(forTotalWeight: 600, scaledWeight: 0, currentFactor: 1) == 1)
    }
}
