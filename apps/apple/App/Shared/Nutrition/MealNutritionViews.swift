import CubbyKit
import SwiftUI

/// Per-person macros with each entered food underneath. The adaptive grid presents two people
/// side by side when space permits and naturally becomes one column on iPhone.
struct MealNutritionPeopleView: View {
    let summary: MealNutritionOut
    var showMealHeadings = false

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        if summary.people.isEmpty {
            Text("No portions entered yet.")
                .foregroundStyle(.secondary)
        } else {
            VStack(alignment: .leading, spacing: FieldGuideTokens.Space.md) {
                LazyVGrid(columns: peopleColumns, alignment: .leading, spacing: FieldGuideTokens.Space.lg) {
                    ForEach(summary.people) { person in
                        personPanel(person)
                    }
                }
                if summary.people.contains(where: { $0.totals.macros.containsPartialEstimate }) {
                    Text("+ means a known subtotal; some food nutrition is missing. — means unavailable.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    private var peopleColumns: [GridItem] {
        [GridItem(.adaptive(minimum: dynamicTypeSize.isAccessibilitySize ? 280 : 310), alignment: .top)]
    }

    private func personPanel(_ person: MealNutritionPerson) -> some View {
        GroupBox {
            VStack(alignment: .leading, spacing: FieldGuideTokens.Space.md) {
                MacroGrid(totals: person.totals.macros, prominent: true)
                if person.foods.isEmpty {
                    Text("No foods assigned")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(Array(person.foods.enumerated()), id: \.element.id) { index, food in
                        if index > 0 { Divider() }
                        if showMealHeadings
                            && (index == 0 || person.foods[index - 1].meal.id != food.meal.id)
                        {
                            mealHeading(food.meal, for: person)
                        }
                        foodRow(food)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        } label: {
            NavigationLink(value: Route.entityDetail(.ledgerParty, id: person.id)) {
                Text(person.name).font(.fieldGuideTitle)
            }
        }
    }

    private func foodRow(_ food: MealNutritionFood) -> some View {
        VStack(alignment: .leading, spacing: FieldGuideTokens.Space.sm) {
            HStack(alignment: .firstTextBaseline, spacing: FieldGuideTokens.Space.sm) {
                foodLink(food)
                    .font(.fieldGuideTitle)
                Spacer(minLength: FieldGuideTokens.Space.sm)
                Text(food.amountDescription)
                    .font(.fieldGuideLabel.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
            if let amount = food.amount, amount.unit != "g" {
                Text("Weight: \(food.weight.formatted(calories: false)) g")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            MacroGrid(totals: food.totals.macros)
        }
        .padding(.vertical, FieldGuideTokens.Space.xs)
    }

    @ViewBuilder private func foodLink(_ food: MealNutritionFood) -> some View {
        switch food {
        case .recipe(let recipe):
            NavigationLink(value: Route.entityDetail(.recipe, id: recipe.recipeId)) { Text(food.name) }
        case .product(let product):
            NavigationLink(value: Route.entityDetail(.product, id: product.productId.rawValue)) {
                Text(food.name)
            }
        case .ingredient(let ingredient):
            NavigationLink(value: Route.entityDetail(.ingredient, id: ingredient.ingredientId)) {
                Text(food.name)
            }
        case .manual:
            Text(food.name)
        }
    }

    private func mealLink(_ meal: NutritionMeal) -> some View {
        NavigationLink(value: Route.entityDetail(.meal, id: meal.id)) {
            Text(meal.displayName)
        }
    }

    private func mealHeading(_ meal: NutritionMeal, for person: MealNutritionPerson) -> some View {
        VStack(alignment: .leading, spacing: FieldGuideTokens.Space.sm) {
            mealLink(meal)
                .font(.fieldGuideTitle)
            if let subtotal = person.meals.first(where: { $0.meal.id == meal.id }) {
                MacroGrid(totals: subtotal.totals.macros)
            }
        }
        .padding(.top, FieldGuideTokens.Space.xs)
    }
}

/// Today's compact home summary: one total row per person and no repeated per-food detail.
struct MealNutritionCompactView: View {
    let summary: MealNutritionOut

    var body: some View {
        if summary.people.isEmpty {
            Text("No food logged yet. Add a portion to see nutrition.")
                .font(.fieldGuideLabel)
                .foregroundStyle(.secondary)
        } else {
            ForEach(summary.people) { person in
                VStack(alignment: .leading, spacing: FieldGuideTokens.Space.sm) {
                    Text(person.name).font(.fieldGuideTitle)
                    MacroGrid(totals: person.totals.macros)
                }
                .padding(.vertical, FieldGuideTokens.Space.xs)
            }
        }
    }
}

private struct MacroGrid: View {
    let totals: MacroSummary
    var prominent = false

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        LazyVGrid(columns: columns, alignment: .leading, spacing: FieldGuideTokens.Space.sm) {
            macro("Calories", amount: totals.calories, unit: "kcal", calories: true)
            macro("Protein", amount: totals.protein, unit: "g")
            macro("Carbs", amount: totals.carbs, unit: "g")
            macro("Fat", amount: totals.fat, unit: "g")
        }
    }

    private var columns: [GridItem] {
        if dynamicTypeSize.isAccessibilitySize {
            return [GridItem(.flexible(), alignment: .leading)]
        }
        return [GridItem(.adaptive(minimum: 70), alignment: .leading)]
    }

    private func macro(
        _ label: String, amount: MeasureEstimate, unit: String, calories: Bool = false
    ) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label)
                .font(.caption)
                .foregroundStyle(.secondary)
            HStack(alignment: .firstTextBaseline, spacing: 3) {
                Text(amount.formatted(calories: calories))
                    .font(
                        prominent ? .title3.weight(.semibold).monospacedDigit() : .callout.monospacedDigit())
                Text(unit)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            if amount.inferredZeroCount > 0 {
                Text("\(amount.inferredZeroCount) inferred from label")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(
            "\(label): \(amount.accessibilityValue(calories: calories)) \(unit)\(amount.inferredZeroCount > 0 ? ", \(amount.inferredZeroCount) contributors inferred from label" : "")"
        )
    }
}

private extension MeasureEstimate {
    /// The cell text pinned by `golden-vectors/display-format.json`, shared with the web.
    func formatted(calories: Bool) -> String {
        DisplayFormat.compactEstimate(self, unit: calories ? .kcal : .macro)
    }

    func accessibilityValue(calories: Bool) -> String {
        let known = DisplayFormat.knownRange(self, unit: calories ? .kcal : .macro)
        return switch self {
        case .complete: known ?? ""
        case .partial: "\(known ?? ""), known subtotal"
        case .unavailable: isNotApplicable ? "not applicable" : "unavailable"
        case .pending: "pending"
        }
    }
}

#Preview("Meal nutrition") {
    NavigationStack {
        Form {
            Section("Nutrition") {
                MealNutritionPeopleView(summary: PreviewFixtures.sampleMealNutrition)
            }
        }
    }
}

#Preview("Compact meal nutrition") {
    List {
        Section("Nutrition today") {
            MealNutritionCompactView(summary: PreviewFixtures.sampleMealNutrition)
        }
    }
}

#Preview("Macro grid") {
    MacroGrid(totals: PreviewFixtures.sampleMealNutrition.people[0].totals.macros, prominent: true)
        .padding()
}
