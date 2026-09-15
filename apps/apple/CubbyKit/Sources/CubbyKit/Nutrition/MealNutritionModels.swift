import Foundation

/// Meal and day nutrition projected out of the generated transport types. The UI needs the four
/// everyday macros while keeping partial, unavailable, and pending estimates truthful.
public struct MealNutritionSummary: Sendable, Hashable {
    public let meals: [MealNutritionMeal]
    public let people: [MealNutritionPerson]

    public init(meals: [MealNutritionMeal], people: [MealNutritionPerson]) {
        self.meals = meals
        self.people = people
    }
}

public struct MealNutritionMeal: Identifiable, Sendable, Hashable {
    public let id: String
    public let date: String
    public let name: String?
    public let mealType: String?

    public init(id: String, date: String, name: String?, mealType: String?) {
        self.id = id
        self.date = date
        self.name = name
        self.mealType = mealType
    }

    public var displayName: String {
        if let name, !name.isEmpty { return name }
        if let mealType { return mealType.capitalized }
        return "Meal"
    }
}

public struct MealNutritionPerson: Identifiable, Sendable, Hashable {
    public let id: String
    public let name: String
    public let totals: MacroSummary
    public let foods: [MealNutritionFood]
    public let meals: [MealNutritionMealSubtotal]

    public init(
        id: String, name: String, totals: MacroSummary, foods: [MealNutritionFood],
        meals: [MealNutritionMealSubtotal] = []
    ) {
        self.id = id
        self.name = name
        self.totals = totals
        self.foods = foods
        self.meals = meals
    }
}

public struct MealNutritionMealSubtotal: Identifiable, Sendable, Hashable {
    public let meal: MealNutritionMeal
    public let totals: MacroSummary

    public init(meal: MealNutritionMeal, totals: MacroSummary) {
        self.meal = meal
        self.totals = totals
    }

    public var id: String { meal.id }
}

public struct MealNutritionFood: Identifiable, Sendable, Hashable {
    public enum Source: Sendable, Hashable {
        case recipe(mealRecipeID: String, recipeID: String, sourceMealID: String)
        case product(id: String, productID: String)
        case manual(id: String)
    }

    public let source: Source
    public let meal: MealNutritionMeal
    public let name: String
    public let grams: Double?
    public let totals: MacroSummary

    public init(
        source: Source, meal: MealNutritionMeal, name: String, grams: Double?, totals: MacroSummary
    ) {
        self.source = source
        self.meal = meal
        self.name = name
        self.grams = grams
        self.totals = totals
    }

    public var id: String {
        switch source {
        case .recipe(let mealRecipeID, _, _): "recipe:\(meal.id):\(mealRecipeID)"
        case .product(let id, _): "product:\(id)"
        case .manual(let id): "manual:\(id)"
        }
    }

    public var sourceKind: String {
        switch source {
        case .recipe: "Recipe"
        case .product: "Product"
        case .manual: "Manual"
        }
    }
}

public struct MacroSummary: Sendable, Hashable {
    public let calories: NutritionAmount
    public let protein: NutritionAmount
    public let carbs: NutritionAmount
    public let fat: NutritionAmount

    public init(
        calories: NutritionAmount, protein: NutritionAmount, carbs: NutritionAmount,
        fat: NutritionAmount
    ) {
        self.calories = calories
        self.protein = protein
        self.carbs = carbs
        self.fat = fat
    }

    public var containsPartialEstimate: Bool {
        [calories, protein, carbs, fat].contains { $0.isPartial }
    }
}

public enum NutritionAmount: Sendable, Hashable {
    case complete(lower: Double, upper: Double?)
    case partial(lower: Double, upper: Double?)
    case unavailable
    case pending

    public var isPartial: Bool {
        if case .partial = self { return true }
        return false
    }
}

/// Calendar-day helpers for the household's configured time zone. Meal planning and logging use
/// this boundary even while the device is travelling elsewhere.
public enum HouseholdDay {
    public static let timeZone = TimeZone(identifier: "America/Los_Angeles")!

    public static func string(for date: Date) -> String {
        let parts = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
    }

    public static func date(from value: String) -> Date? {
        formatter.date(from: value)
    }

    public static func isFuture(_ value: String, relativeTo now: Date = .now) -> Bool {
        guard let candidate = Self.date(from: value),
            let today = Self.date(from: Self.string(for: now))
        else { return false }
        return candidate > today
    }

    private static var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        return calendar
    }

    private static var formatter: DateFormatter {
        let formatter = DateFormatter()
        formatter.calendar = calendar
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = timeZone
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter
    }
}
