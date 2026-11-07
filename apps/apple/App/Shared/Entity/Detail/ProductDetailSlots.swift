import CubbyKit
import SwiftUI

/// Renders the server's `nutritionDisplay` (source, basis, rows); which source leads is not decided here.
struct ProductNutritionDetailSlot: View {
    let row: EntityRow

    private var display: Result<ProductNutritionDisplay, any Error> {
        Result {
            guard let value = row.raw.recordValue("nutritionDisplay") else {
                throw DecodingError.dataCorrupted(
                    .init(
                        codingPath: [],
                        debugDescription: "Product.nutritionDisplay: required presentation is missing"))
            }
            return try value.decoded(ProductNutritionDisplay.self)
        }
    }

    var body: some View {
        switch display {
        case .success(let display): nutritionContents(display)
        case .failure(let error):
            Text(error.userMessage).foregroundStyle(FieldGuideTokens.destructive)
                .task { Diagnostics.report(error, context: "product.nutrition-display") }
        }
    }

    @ViewBuilder private func nutritionContents(_ display: ProductNutritionDisplay) -> some View {
        if display.rows.isEmpty {
            Text(display.title).foregroundStyle(.secondary)
        } else {
            VStack(alignment: .leading, spacing: FieldGuideTokens.Space.sm) {
                Text(display.title).font(.headline)
                Text(display.basis).font(.caption).foregroundStyle(.secondary)
                ForEach(display.rows, id: \.key) { nutrient in
                    LabeledContent(
                        nutrient.label,
                        value: nutrient.inferred
                            ? "0 · inferred from label"
                            : nutrient.amount.formatted(.number.precision(.fractionLength(0...3))))
                }
                if let evidence = display.inferenceEvidence {
                    Text(evidence).font(.caption).foregroundStyle(.secondary)
                }
                if let source = display.sourceNote {
                    Text(source).font(.caption).foregroundStyle(.secondary)
                }
            }
        }
    }
}

struct ProductUnitMappingsDetailSlot: View {
    let row: EntityRow
    private var mappings: [JSONValue] { row.raw["unitMappings"]?.arrayValue ?? [] }

    var body: some View {
        if mappings.isEmpty {
            Text("No unit conversions recorded.").foregroundStyle(.secondary)
        } else {
            ForEach(Array(mappings.enumerated()), id: \.offset) { indexed in
                let mapping = indexed.element
                VStack(alignment: .leading, spacing: FieldGuideTokens.Space.xs) {
                    Text("\(amount(mapping["a"])) = \(amount(mapping["b"]))")
                    if let source = mapping["source"]?.stringValue {
                        Text(source).font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
        }
    }

    private func amount(_ value: JSONValue?) -> String {
        guard let number = value?["value"]?.doubleValue, let unit = value?["unit"]?.stringValue else {
            return "Unknown amount"
        }
        return "\(number.formatted(.number.precision(.fractionLength(0...6)))) \(unit)"
    }
}

struct RelatedRecordsDetailSlot: View {
    let source: EntityRef
    @Environment(AppModel.self) private var appModel
    @State private var group: RecommendationWorkbenchOut?
    @State private var error: String?
    @State private var visibleCount = 12

    var body: some View {
        VStack(alignment: .leading, spacing: FieldGuideTokens.Space.sm) {
            if let group {
                if group.status != .ready {
                    Text(
                        group.status == .unavailable
                            ? "Similarity is unavailable until embeddings are configured."
                            : "Similarity index has not been computed or is stale."
                    )
                    .font(.caption).foregroundStyle(.secondary)
                }
                ForEach(Array(group.items.prefix(visibleCount).enumerated()), id: \.offset) { indexed in
                    let proposal = indexed.element
                    NavigationLink(value: Route.entityDetail(proposal.entity, id: proposal.shortcode)) {
                        VStack(alignment: .leading, spacing: FieldGuideTokens.Space.xs) {
                            Text(proposal.title)
                            Text(
                                proposal.evidence.map { evidence in
                                    evidence.detail.map { "\(evidence.signal): \($0)" } ?? evidence.signal
                                }.joined(separator: " · ")
                            )
                            .font(.caption).foregroundStyle(.secondary)
                            if proposal.score > 0 {
                                Text("\(Int((proposal.score * 100).rounded()))% similar")
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                        }
                        .frame(minHeight: FieldGuideTokens.touchTarget)
                    }
                }
                if group.items.count > visibleCount {
                    Button("Show \(min(12, group.items.count - visibleCount)) more records") {
                        visibleCount += 12
                    }
                }
                if group.items.isEmpty && group.status == .ready {
                    Text("No related records yet.").foregroundStyle(.secondary)
                }
            } else if error == nil {
                LoadingIndicator(label: "Loading related records")
            }
            if let error {
                InlineLoadFailure(message: error) { await load() }
            }
        }
        .task(id: source) {
            visibleCount = 12; await load()
        }
    }

    private func load() async {
        error = nil
        do {
            let document = try await appModel.client.relatedness(
                for: source)
            guard !Task.isCancelled else { return }
            group = document
        } catch {
            guard !Task.isCancelled else { return }
            Diagnostics.report(error, context: "Related records")
            self.error = error.localizedDescription
        }
    }
}

#Preview("Nutrition") { Form { ProductNutritionDetailSlot(row: EntityScreenFixture.product.detailRow) } }
#Preview("Unit mappings") {
    Form { ProductUnitMappingsDetailSlot(row: EntityScreenFixture.product.detailRow) }
}
#Preview("Related records") {
    Form { RelatedRecordsDetailSlot(source: .init(entity: .product, id: "PRD-2345")) }.environment(
        PreviewFixtures.signedInModel())
}
