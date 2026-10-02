import CubbyKit
import SwiftUI

struct ProductNutritionDetailSlot: View {
    let row: EntityRow

    private var label: JSONValue? { row.raw["labelNutrition"] }
    private var hasLabel: Bool { label?.objectValue != nil }
    private var nutrients: [String: JSONValue] { label?["nutrients"]?.objectValue ?? [:] }
    private var inferredZeroNutrients: [String] {
        (label?["inferredZeroNutrients"]?.arrayValue ?? []).compactMap(\.stringValue)
            .filter { nutrients[$0]?.doubleValue == nil }
            .sorted()
    }
    private var usdaNutrients: [JSONValue] {
        row.raw["food"]?["nutritionInfo"]?["nutrientSummary"]?.arrayValue ?? []
    }

    var body: some View {
        if !hasLabel && usdaNutrients.isEmpty {
            Text("No nutrition on file — link a USDA food or enter the package label.")
                .foregroundStyle(.secondary)
        } else {
            VStack(alignment: .leading, spacing: FieldGuideTokens.Space.sm) {
                Text(hasLabel ? "From package label" : "From USDA")
                    .font(.headline)
                if hasLabel, let grams = label?["servingGrams"]?.doubleValue {
                    Text("Per serving · \(grams.formatted()) g").font(.caption).foregroundStyle(.secondary)
                } else {
                    Text("Per 100 g").font(.caption).foregroundStyle(.secondary)
                }
                if hasLabel {
                    ForEach(nutrients.keys.sorted(), id: \.self) { key in
                        if let value = nutrients[key]?.doubleValue {
                            LabeledContent(
                                NutrientCatalog.labels[key] ?? key,
                                value: value.formatted(.number.precision(.fractionLength(0...3))))
                        }
                    }
                    ForEach(inferredZeroNutrients, id: \.self) { key in
                        LabeledContent(NutrientCatalog.labels[key] ?? key, value: "0 · inferred from label")
                    }
                    if !inferredZeroNutrients.isEmpty, let evidence = label?["inferenceEvidence"]?.stringValue
                    {
                        Text(evidence).font(.caption).foregroundStyle(.secondary)
                    }
                } else {
                    ForEach(Array(usdaNutrients.enumerated()), id: \.offset) { indexed in
                        let nutrient = indexed.element
                        if let name = nutrient["name"]?.stringValue,
                            let value = nutrient["amount"]?.doubleValue
                        {
                            LabeledContent(
                                "\(name) (\(nutrient["unit"]?.stringValue ?? ""))",
                                value: value.formatted(.number.precision(.fractionLength(0...3))))
                        }
                    }
                }
                if let source = label?["source"]?.stringValue {
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

struct ProductSimilarityDetailSlot: View {
    let productID: String
    @Environment(AppModel.self) private var appModel
    @State private var group: EntityRecommendationGroupProductRelated?
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
                ForEach(Array(group.proposals.prefix(visibleCount).enumerated()), id: \.offset) { indexed in
                    let proposal = indexed.element
                    NavigationLink(value: Route.entityDetail(.product, id: proposal.target.id.rawValue)) {
                        VStack(alignment: .leading, spacing: FieldGuideTokens.Space.xs) {
                            Text(proposal.target.name)
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
                if group.proposals.count > visibleCount {
                    Button("Show \(min(12, group.proposals.count - visibleCount)) more products") {
                        visibleCount += 12
                    }
                }
                if group.proposals.isEmpty && group.status == .ready {
                    Text("No related products yet.").foregroundStyle(.secondary)
                }
            } else if error == nil {
                LoadingIndicator(label: "Loading similar products")
            }
            if let error {
                Text(error).foregroundStyle(.secondary)
                Button("Retry") { Task { await load() } }
            }
        }
        .task(id: productID) {
            visibleCount = 12; await load()
        }
    }

    private func load() async {
        error = nil
        do {
            let document = try await appModel.client.recommendations(
                for: EntityRef(entity: .product, id: productID))
            guard !Task.isCancelled else { return }
            group =
                document.groups.compactMap { candidate in
                    if case .productRelated(let group) = candidate { return group }
                    return nil
                }.first
        } catch {
            guard !Task.isCancelled else { return }
            Diagnostics.report(error, context: "Product similarity")
            self.error = error.localizedDescription
        }
    }
}

struct ProductEnrichmentHistorySlot: View {
    let productID: String
    @Environment(AppModel.self) private var appModel
    @State private var history: RunHistoryOut?
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: FieldGuideTokens.Space.sm) {
            if let history {
                if history.runs.isEmpty {
                    Text("No targeted enrichment runs have been recorded.").foregroundStyle(.secondary)
                }
                ForEach(Array(history.runs.enumerated()), id: \.offset) { indexed in
                    let run = indexed.element
                    NavigationLink {
                        RunReviewView(runID: run.publicId)
                    } label: {
                        VStack(alignment: .leading, spacing: FieldGuideTokens.Space.xs) {
                            Text(run.vendorName ?? run.vendorAccountLabel ?? "Product enrichment")
                            Text("\(run.status) · \(run.trigger)").font(.caption).foregroundStyle(.secondary)
                            Text(run.startedAt.formatted(date: .abbreviated, time: .shortened))
                                .font(.caption).foregroundStyle(.secondary)
                            if let code = run.failureCode { Text(code).foregroundStyle(.secondary) }
                        }
                    }
                }
            } else if error == nil {
                LoadingIndicator(label: "Loading enrichment history")
            }
            if let error {
                Text(error).foregroundStyle(.secondary)
                Button("Retry") { Task { await load() } }
            }
        }
        .task(id: productID) {
            history = nil; await load()
        }
    }

    private func load() async {
        error = nil
        do {
            let result = try await appModel.client.runHistory(.init(productId: productID))
            guard !Task.isCancelled else { return }
            history = result
        } catch {
            guard !Task.isCancelled else { return }
            Diagnostics.report(error, context: "Product enrichment history")
            self.error = error.localizedDescription
        }
    }
}

#Preview("Nutrition") { Form { ProductNutritionDetailSlot(row: PreviewFixtures.sampleDetailRow) } }
#Preview("Unit mappings") { Form { ProductUnitMappingsDetailSlot(row: PreviewFixtures.sampleDetailRow) } }
#Preview("Similar products") {
    Form { ProductSimilarityDetailSlot(productID: "PRD-2345") }.environment(PreviewFixtures.signedInModel())
}
#Preview("Enrichment history") {
    Form { ProductEnrichmentHistorySlot(productID: "PRD-2345") }.environment(PreviewFixtures.signedInModel())
}
