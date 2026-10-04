import CubbyFFI
import Foundation

/// Recipe scaling arithmetic from the Rust the web runs as WASM (`recipebridge/src/scaling.rs` and
/// `scale_amount`). Swift never multiplies an amount: which units scale (not a pan size, oven
/// temperature or rest time), how an anchor resolves to a factor, and how a scaled count rounds
/// are Rust's call.
public enum RecipeScaling {
    /// A usable factor: finite, positive, floored at 0.01; anything else is 1.
    public static func clamp(_ factor: Double) -> Double {
        CubbyFFI.clampScaleFactor(factor: factor)
    }

    /// The factor that turns an ingredient's `original` amount into `newValue`.
    public static func factor(original: Double, setTo newValue: Double) -> Double {
        CubbyFFI.scaleFactorForIngredient(originalValue: original, newValue: newValue)
    }

    /// A yield or serving count at `factor`, rounded to two decimals.
    public static func count(_ value: Double, factor: Double) -> Double {
        CubbyFFI.scaleDisplayCount(value: value, factor: factor)
    }

    /// The amount at `factor`, with its authored unit spelling kept.
    public static func scale(_ amount: IngredientParser.Amount, by factor: Double) -> IngredientParser.Amount
    {
        let scaled = CubbyFFI.scaleAmount(
            unit: amount.unit, value: amount.value, upperValue: amount.upperValue, factor: factor)
        return IngredientParser.Amount(value: scaled.value, upperValue: scaled.upperValue, unit: scaled.unit)
    }
}

/// A recipe detail row read for cooking: ingredient lines per section and the instructions as one
/// ordered list of steps. Pure value; scaling and printing go through `RecipeScaling` and
/// `ValueFormat`, so a line reads the same as on web at any factor.
public struct RecipeCookPlan: Sendable, Equatable {
    public struct IngredientLine: Sendable, Equatable, Identifiable {
        public let id: Int
        public let name: String
        public let modifier: String?
        public let amounts: [IngredientParser.Amount]
    }

    public struct Section: Sendable, Equatable, Identifiable {
        public let id: Int
        public let name: String?
        public let ingredients: [IngredientLine]
    }

    public struct Step: Sendable, Equatable, Identifiable {
        public let id: Int
        public let sectionIndex: Int
        public let sectionName: String?
        /// 1-based within its section, the way the method is numbered on the recipe.
        public let numberInSection: Int
        public let text: String
    }

    public let title: String
    public let sections: [Section]
    public let steps: [Step]
    private let yieldValue: Double?
    private let yieldUnit: String?
    private let servingsValue: Double?

    /// `nil` when the row carries no `sections` array (a list row, not the detail payload).
    public init?(recipe: JSONValue) {
        guard let rawSections = recipe["sections"]?.arrayValue else { return nil }
        title = recipe["name"]?.stringValue ?? ""
        var lineID = 0
        var sections: [Section] = []
        var steps: [Step] = []
        for (sectionIndex, rawSection) in rawSections.enumerated() {
            let name = rawSection["name"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 }
            let lines: [IngredientLine] = (rawSection["ingredients"]?.arrayValue ?? []).map { raw in
                defer { lineID += 1 }
                // A sub-recipe row names its recipe; an ingredient row names its ingredient.
                let target = raw["ingredient"] ?? raw["recipe"]
                return IngredientLine(
                    id: lineID,
                    name: target?["name"]?.stringValue ?? raw["rawLine"]?.stringValue ?? "",
                    modifier: raw["modifier"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 },
                    amounts: (raw["amounts"]?.arrayValue ?? []).compactMap { amount in
                        guard let value = amount["value"]?.doubleValue, let unit = amount["unit"]?.stringValue
                        else { return nil }
                        return IngredientParser.Amount(
                            value: value, upperValue: amount["upperValue"]?.doubleValue, unit: unit)
                    })
            }
            sections.append(Section(id: sectionIndex, name: name, ingredients: lines))
            for (index, instruction) in (rawSection["instructions"]?.arrayValue ?? []).enumerated() {
                guard let text = instruction["instruction"]?.stringValue else { continue }
                steps.append(
                    Step(
                        id: steps.count, sectionIndex: sectionIndex, sectionName: name,
                        numberInSection: index + 1, text: text))
            }
        }
        self.sections = sections
        self.steps = steps
        yieldValue = recipe["yield"]?["value"]?.doubleValue
        yieldUnit = recipe["yield"]?["unit"]?.stringValue
        servingsValue = recipe["servings"]?.doubleValue
    }

    /// One ingredient line at `factor`: `4 cup (500 g) flour, sifted`.
    public func line(_ line: IngredientLine, factor: Double) -> String {
        let printed = line.amounts.map { amount -> String in
            let scaled = RecipeScaling.scale(amount, by: factor)
            return ValueFormat.amount(unit: scaled.unit, value: scaled.value, upperValue: scaled.upperValue)
        }
        var parts: [String] = []
        if let primary = printed.first { parts.append(primary) }
        if printed.count > 1 { parts.append("(\(printed.dropFirst().joined(separator: ", ")))") }
        parts.append(line.name)
        let text = parts.joined(separator: " ")
        return line.modifier.map { "\(text), \($0)" } ?? text
    }

    /// `6 serving` at 1.5×, or `nil` for a recipe with no yield.
    public func yieldLabel(factor: Double) -> String? {
        yieldValue.map {
            ValueFormat.amount(unit: yieldUnit, value: RecipeScaling.count($0, factor: factor))
        }
    }

    public func servings(factor: Double) -> Double? {
        servingsValue.map { RecipeScaling.count($0, factor: factor) }
    }
}
