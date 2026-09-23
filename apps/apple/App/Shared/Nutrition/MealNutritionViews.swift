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
            VStack(alignment: .leading, spacing: PorcelainTokens.Space.md) {
                LazyVGrid(columns: peopleColumns, alignment: .leading, spacing: PorcelainTokens.Space.lg) {
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
            VStack(alignment: .leading, spacing: PorcelainTokens.Space.md) {
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
                Text(person.name).font(.porcelainTitle)
            }
        }
    }

    private func foodRow(_ food: MealNutritionFood) -> some View {
        VStack(alignment: .leading, spacing: PorcelainTokens.Space.sm) {
            HStack(alignment: .firstTextBaseline, spacing: PorcelainTokens.Space.sm) {
                foodLink(food)
                    .font(.porcelainTitle)
                Spacer(minLength: PorcelainTokens.Space.sm)
                Text(food.amountDescription)
                    .font(.porcelainLabel.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
            if let amount = food.amount, amount.unit != "g" {
                Text("Weight: \(food.weight.formatted(calories: false)) g")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            MacroGrid(totals: food.totals.macros)
        }
        .padding(.vertical, PorcelainTokens.Space.xs)
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
        VStack(alignment: .leading, spacing: PorcelainTokens.Space.sm) {
            mealLink(meal)
                .font(.porcelainTitle)
            if let subtotal = person.meals.first(where: { $0.meal.id == meal.id }) {
                MacroGrid(totals: subtotal.totals.macros)
            }
        }
        .padding(.top, PorcelainTokens.Space.xs)
    }
}

/// Today's compact home summary: one total row per person and no repeated per-food detail.
struct MealNutritionCompactView: View {
    let summary: MealNutritionOut

    var body: some View {
        if summary.people.isEmpty {
            Text("No food logged yet. Add a portion to see nutrition.")
                .font(.porcelainLabel)
                .foregroundStyle(.secondary)
        } else {
            ForEach(summary.people) { person in
                VStack(alignment: .leading, spacing: PorcelainTokens.Space.sm) {
                    Text(person.name).font(.porcelainTitle)
                    MacroGrid(totals: person.totals.macros)
                }
                .padding(.vertical, PorcelainTokens.Space.xs)
            }
        }
    }
}

private struct MacroGrid: View {
    let totals: MacroSummary
    var prominent = false

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        LazyVGrid(columns: columns, alignment: .leading, spacing: PorcelainTokens.Space.sm) {
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
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(label): \(amount.accessibilityValue(calories: calories)) \(unit)")
    }
}

private extension MeasureEstimate {
    func formatted(calories: Bool) -> String {
        switch self {
        case .complete(let estimate): format(lower: estimate.lower, upper: estimate.upper, calories: calories)
        case .partial(let estimate):
            "\(format(lower: estimate.lower, upper: estimate.upper, calories: calories))+"
        case .unavailable, .pending: "—"
        }
    }

    func accessibilityValue(calories: Bool) -> String {
        switch self {
        case .complete(let estimate): format(lower: estimate.lower, upper: estimate.upper, calories: calories)
        case .partial(let estimate):
            "\(format(lower: estimate.lower, upper: estimate.upper, calories: calories)), known subtotal"
        case .unavailable: "unavailable"
        case .pending: "pending"
        }
    }

    private func format(lower: Double, upper: Double?, calories: Bool) -> String {
        let lowerText = number(lower, calories: calories)
        guard let upper, upper != lower else { return lowerText }
        return "\(lowerText)–\(number(upper, calories: calories))"
    }

    private func number(_ value: Double, calories: Bool) -> String {
        if calories { return value.formatted(.number.precision(.fractionLength(0))) }
        return value.formatted(.number.precision(.fractionLength(0...1)))
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
