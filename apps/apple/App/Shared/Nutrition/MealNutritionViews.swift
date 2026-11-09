import CubbyKit
import SwiftUI

/// Per-person macros with each entered food underneath. `.panels` (inside a record's Form
/// section) presents two people side by side when space permits; `.sections` (a List of its own,
/// the daily screen) gives each person a plain section rather than a card inside a card.
struct MealNutritionPeopleView: View {
    enum Layout {
        case panels
        case sections
    }

    let summary: MealNutritionOut
    var showMealHeadings = false
    var layout: Layout = .panels

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    private var hasPartialEstimate: Bool {
        summary.people.contains(where: { $0.totals.macros.containsPartialEstimate })
    }

    private static let partialNote =
        "+ means a known subtotal; some food nutrition is missing. — means unavailable."

    var body: some View {
        if summary.people.isEmpty {
            Text("No portions entered yet.")
                .font(.callout)
                .foregroundStyle(.secondary)
        } else if layout == .sections {
            ForEach(Array(summary.people.enumerated()), id: \.element.id) { index, person in
                Section {
                    MacroGrid(totals: person.totals.macros, prominent: true)
                        .padding(.vertical, FieldGuideTokens.Space.xs)
                    personFoods(person)
                } header: {
                    NavigationLink(value: Route.entityDetail(.ledgerParty, id: person.id)) {
                        Text(person.name)
                    }
                    .buttonStyle(.plain)
                } footer: {
                    if hasPartialEstimate, index == summary.people.count - 1 {
                        Text(Self.partialNote)
                    }
                }
            }
        } else {
            VStack(alignment: .leading, spacing: FieldGuideTokens.Space.md) {
                LazyVGrid(columns: peopleColumns, alignment: .leading, spacing: FieldGuideTokens.Space.lg) {
                    ForEach(summary.people) { person in
                        personPanel(person)
                    }
                }
                if hasPartialEstimate {
                    Text(Self.partialNote)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    private var peopleColumns: [GridItem] {
        [GridItem(.adaptive(minimum: dynamicTypeSize.isAccessibilitySize ? 280 : 310), alignment: .top)]
    }

    /// Each food with its meal heading where the meal changes. In a section, each food is its own
    /// row (the List draws separators); in a panel, dividers separate them.
    @ViewBuilder private func personFoods(_ person: MealNutritionPerson) -> some View {
        if person.foods.isEmpty {
            Text("No foods assigned")
                .font(.callout)
                .foregroundStyle(.secondary)
        } else {
            ForEach(Array(person.foods.enumerated()), id: \.offset) { index, food in
                if layout == .panels, index > 0 { Divider() }
                if showMealHeadings, let meal = food.meal,
                    index == 0 || person.foods[index - 1].meal?.id != meal.id
                {
                    mealHeading(meal, for: person)
                }
                foodRow(food)
            }
        }
    }

    private func personPanel(_ person: MealNutritionPerson) -> some View {
        GroupBox {
            VStack(alignment: .leading, spacing: FieldGuideTokens.Space.md) {
                MacroGrid(totals: person.totals.macros, prominent: true)
                personFoods(person)
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
            if let amount = food.amount, amount.unit != "g", let weight = food.weight {
                Text("Weight: \(weight.formatted(calories: false)) g")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            if let totals = food.totals {
                MacroGrid(totals: totals.macros)
            } else if case .unrecognized(let raw) = food {
                Text("Unsupported food response: \(String(describing: raw))")
                    .font(.caption).textSelection(.enabled)
            }
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
        case .manual, .unrecognized:
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
                .font(.callout)
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

    /// Four across, then two by two, then one column: a figure never wraps its unit or its
    /// partial-estimate "+" onto a second line.
    var body: some View {
        if dynamicTypeSize.isAccessibilitySize {
            VStack(alignment: .leading, spacing: FieldGuideTokens.Space.sm) { cells }
        } else {
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .top, spacing: FieldGuideTokens.Space.lg) { cells }
                Grid(
                    alignment: .leading, horizontalSpacing: FieldGuideTokens.Space.lg,
                    verticalSpacing: FieldGuideTokens.Space.sm
                ) {
                    GridRow {
                        macro("Calories", amount: totals.calories, unit: "kcal", calories: true)
                        macro("Protein", amount: totals.protein, unit: "g")
                    }
                    GridRow {
                        macro("Carbs", amount: totals.carbs, unit: "g")
                        macro("Fat", amount: totals.fat, unit: "g")
                    }
                }
                VStack(alignment: .leading, spacing: FieldGuideTokens.Space.sm) { cells }
            }
        }
    }

    @ViewBuilder private var cells: some View {
        macro("Calories", amount: totals.calories, unit: "kcal", calories: true)
        macro("Protein", amount: totals.protein, unit: "g")
        macro("Carbs", amount: totals.carbs, unit: "g")
        macro("Fat", amount: totals.fat, unit: "g")
    }

    private func macro(
        _ label: String, amount: MeasureEstimate, unit: String, calories: Bool = false
    ) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label)
                .font(.caption)
                .foregroundStyle(.secondary)
            let value = amount.formatted(calories: calories)
            HStack(alignment: .firstTextBaseline, spacing: 3) {
                Text(value)
                    .font(
                        prominent ? .title3.weight(.semibold).monospacedDigit() : .callout.monospacedDigit())
                // The shared cell writes "—" for an unavailable value; a unit beside it says nothing.
                if value != "—" {
                    Text(unit)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .lineLimit(1)
            .fixedSize()
            if let count = amount.inferredZeroCount, count > 0 {
                Text("\(count) inferred from label")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(
            "\(label): \(amount.accessibilityValue(calories: calories, unit: unit))\(amount.inferredZeroCount.map { $0 > 0 ? ", \($0) contributors inferred from label" : "" } ?? "")"
        )
    }
}

private extension MeasureEstimate {
    /// The cell text pinned by `golden-vectors/display-format.json`, shared with the web.
    func formatted(calories: Bool) -> String {
        ValueFormat.compactEstimate(self, unit: calories ? .kcal : .macro)
    }

    func accessibilityValue(calories: Bool, unit: String) -> String {
        ValueFormat.estimate(self, measure: calories ? .kcal : .macro, unit: unit)
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
