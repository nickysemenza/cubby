import CubbyKit
import SwiftUI

/// `ingredient.nutrition-product`: the nutrition of the one product the server chose to supply
/// this ingredient (`nutritionProduct`, shared with web). Which product and which source lead
/// are server decisions; this only draws them.
struct IngredientNutritionProductSlot: View {
    let row: EntityRow

    var body: some View {
        if let chosen = row.raw["nutritionProduct"], let display = chosen["display"],
            let title = display["title"]?.stringValue
        {
            VStack(alignment: .leading, spacing: FieldGuideTokens.Space.sm) {
                if let productID = chosen["productId"]?.stringValue {
                    NavigationLink(value: Route.entityDetail(.product, id: productID)) {
                        Text(Self.caption(chosen)).frame(minHeight: FieldGuideTokens.touchTarget)
                    }
                }
                Text(title).font(.headline)
                if let basis = display["basis"]?.stringValue, !basis.isEmpty {
                    Text(basis).font(.caption).foregroundStyle(.secondary)
                }
                ForEach(display["rows"]?.arrayValue ?? [], id: \.self) { nutrient in
                    LabeledContent(
                        nutrient["label"]?.stringValue ?? "",
                        value: Self.amount(nutrient))
                }
                if let evidence = display["inferenceEvidence"]?.stringValue {
                    Text(evidence).font(.caption).foregroundStyle(.secondary)
                }
                if let note = display["sourceNote"]?.stringValue {
                    Text(note).font(.caption).foregroundStyle(.secondary)
                }
            }
        } else {
            Text(
                "No nutrition on file — none of this ingredient's products carries a USDA food or a package label."
            )
            .foregroundStyle(.secondary)
        }
    }

    static func caption(_ chosen: JSONValue) -> String {
        let name = chosen["name"]?.stringValue ?? "Product"
        guard let maker = chosen["manufacturer"]?.stringValue, !maker.isEmpty else { return name }
        return "\(name) by \(maker)"
    }

    static func amount(_ nutrient: JSONValue) -> String {
        guard let value = nutrient["amount"]?.doubleValue else { return "" }
        let text = ValueFormat.number(value)
        return nutrient["inferred"]?.boolValue == true ? "\(text) · inferred from label" : text
    }
}

/// `ingredient.recipe-usages`: every recipe line using this ingredient, from the detail payload's
/// `recipeUsages`. Re-parsing a drifted line stays on web.
struct IngredientRecipeUsagesSlot: View {
    let row: EntityRow

    private var usages: [JSONValue] { row.raw["recipeUsages"]?.arrayValue ?? [] }

    var body: some View {
        if usages.isEmpty {
            Text("Not used in any recipes yet.").foregroundStyle(.secondary)
        } else {
            ForEach(usages, id: \.self) { usage in
                let recipeName = usage["recipe"]?["name"]?.stringValue ?? "Recipe"
                let label = VStack(alignment: .leading, spacing: FieldGuideTokens.Space.xs) {
                    Text(recipeName)
                    Text(Self.line(usage)).font(.caption).foregroundStyle(.secondary)
                    if let section = usage["sectionName"]?.stringValue, !section.isEmpty {
                        Text(section).font(.caption).foregroundStyle(.secondary)
                    }
                }
                .frame(maxWidth: .infinity, minHeight: FieldGuideTokens.touchTarget, alignment: .leading)
                if let recipeID = usage["recipe"]?["id"]?.stringValue {
                    NavigationLink(value: Route.entityDetail(.recipe, id: recipeID)) { label }
                } else {
                    label
                }
            }
        }
    }

    /// The line as written, else its parsed amounts.
    static func line(_ usage: JSONValue) -> String {
        if let raw = usage["rawLine"]?.stringValue, !raw.isEmpty { return raw }
        let amounts = (usage["amounts"]?.arrayValue ?? []).compactMap { amount -> String? in
            guard let value = amount["value"]?.doubleValue else { return nil }
            return ValueFormat.amount(
                unit: amount["unit"]?.stringValue, value: value, upperValue: amount["upperValue"]?.doubleValue
            )
        }
        return amounts.isEmpty ? "No amount" : amounts.joined(separator: " · ")
    }
}

/// `cookbook.toc`: which ingredients the book's recipes use most, from `recipe.getIngredientUsage`
/// scoped to this cookbook. The share is the server's rounded percent.
struct CookbookContentsSlot: View {
    let cookbookID: String
    @Environment(AppModel.self) private var appModel
    @State private var usage: IngredientUsage?
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: FieldGuideTokens.Space.sm) {
            if let usage {
                CookbookContentsList(usage: usage)
            } else if let error {
                Text(error).foregroundStyle(.secondary)
                Button("Retry") { Task { await load() } }
            } else {
                LoadingIndicator(label: "Loading contents")
            }
        }
        .task(id: cookbookID) { await load() }
    }

    private func load() async {
        error = nil
        do {
            let loaded = try await appModel.client.ingredientUsage(
                .init(input: .init(cookbookId: CookbookShortcode(cookbookID))))
            guard !Task.isCancelled else { return }
            usage = loaded
        } catch {
            guard !Task.isCancelled else { return }
            Diagnostics.report(error, context: "Cookbook contents")
            self.error = error.localizedDescription
        }
    }
}

struct CookbookContentsList: View {
    let usage: IngredientUsage
    @State private var visibleCount = 25

    var body: some View {
        if usage.rows.isEmpty {
            Text("No ingredient usage to show. Add recipes with ingredients to see usage counts.")
                .foregroundStyle(.secondary)
        } else {
            Text("\(usage.rows.count) ingredients across \(ValueFormat.number(usage.totalRecipes)) recipes")
                .font(.caption).foregroundStyle(.secondary)
            ForEach(usage.rows.prefix(visibleCount), id: \.ingredientId) { row in
                NavigationLink(value: Route.entityDetail(.ingredient, id: row.ingredientId)) {
                    LabeledContent(
                        row.name,
                        value:
                            "\(ValueFormat.number(row.recipeCount)) · \(ValueFormat.number(row.sharePercent))%"
                    )
                    .frame(minHeight: FieldGuideTokens.touchTarget)
                }
            }
            if usage.rows.count > visibleCount {
                Button("Show \(min(25, usage.rows.count - visibleCount)) more ingredients") {
                    visibleCount += 25
                }
            }
        }
    }
}

/// `cookbook.import-progress`: how much of the book's source has become recipes. Reprocessing and
/// the add-from-source picker stream per-recipe progress and stay on web.
struct CookbookImportProgressSlot: View {
    let row: EntityRow
    @Environment(AppModel.self) private var appModel

    var body: some View {
        let imported = row.raw["recipeCount"]?.doubleValue ?? 0
        let source = row.raw["sourceRecipeCount"]?.doubleValue ?? 0
        VStack(alignment: .leading, spacing: FieldGuideTokens.Space.sm) {
            if row.raw["needsReextract"]?.boolValue == true {
                Label(
                    "Extracted with a retired format. Re-extract from the EPUB on web to restore the source, its run report, and sub-recipe links.",
                    systemImage: "exclamationmark.triangle"
                )
                .font(.caption).foregroundStyle(FieldGuideTokens.warning)
            }
            if source > 0 {
                ProgressView(value: min(imported, source), total: source)
            }
            Text(
                "\(ValueFormat.number(imported)) of \(ValueFormat.number(source)) source recipes imported."
            )
            .font(.caption).foregroundStyle(.secondary)
            if imported < source {
                Link(
                    "Add or reprocess recipes on web",
                    destination: appModel.webURL(for: .cookbook, id: row.id))
            }
        }
    }
}

#Preview("Cookbook contents") {
    NavigationStack {
        List {
            CookbookContentsList(
                usage: .init(
                    rows: [
                        .init(ingredientId: "ING-4K7M", name: "Flour", recipeCount: 9, sharePercent: 75),
                        .init(ingredientId: "ING-5N8P", name: "Butter", recipeCount: 6, sharePercent: 50),
                    ], totalRecipes: 12))
        }
    }
}

#Preview("Ingredient nutrition product") {
    List {
        IngredientNutritionProductSlot(
            row: EntityRow(
                id: "ING-4K7M", title: "Flour", subtitle: nil, imageURL: nil,
                raw: .object([
                    "nutritionProduct": .object([
                        "productId": .string("PRD-4K7M"), "name": .string("Synthetic Flour"),
                        "manufacturer": .string("Example Mill"),
                        "display": .object([
                            "title": .string("From package label"), "basis": .string("Per serving · 30 g"),
                            "rows": .array([
                                .object([
                                    "label": .string("Protein (g)"), "amount": .number(3),
                                    "inferred": .bool(false),
                                ])
                            ]),
                        ]),
                    ])
                ])))
    }
}

#Preview("Ingredient recipe usages") {
    List {
        IngredientRecipeUsagesSlot(
            row: EntityRow(
                id: "ING-4K7M", title: "Flour", subtitle: nil, imageURL: nil,
                raw: .object([
                    "recipeUsages": .array([
                        .object([
                            "recipe": .object(["id": .string("RCP-4K7M"), "name": .string("Synthetic Tart")]),
                            "sectionName": .string("Crust"), "rawLine": .string("2 cups flour"),
                        ])
                    ])
                ])))
    }
}
