import CubbyKit
import SwiftUI

/// Renders the server's `nutritionDisplay` (source, basis, rows); which source leads is not decided here.
struct ProductNutritionDetailSlot: View {
    let row: EntityRow

    private var display: ProductNutritionDisplay? { try? row.decode(ProductDetail.self).nutritionDisplay }

    var body: some View {
        if let display {
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
                InlineLoadFailure(message: error) { await load() }
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
                InlineLoadFailure(message: error) { await load() }
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
