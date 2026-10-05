import CubbyKit
import SwiftUI

/// Existing Products that may match a proposed photo group, and what choosing one keeps and adds.
struct PhotoCandidateSelectionView: View {
    let runID: String
    let group: PhotoGroupProposal
    let images: [PhotoRunImage]
    let onChosen: () -> Void

    @Environment(AppModel.self) private var appModel
    @Environment(\.dismiss) private var dismiss
    @State private var candidates: [PhotoProductCandidate] = []
    @State private var error: String?
    @State private var loading = true
    @State private var choosing = false
    @State private var searchingAll = false
    @State private var previewCandidate: PhotoProductCandidate?

    var body: some View {
        List {
            Section("Your photos") {
                ScrollView(.horizontal) {
                    HStack(spacing: FieldGuideTokens.Space.sm) {
                        ForEach(group.images, id: \.id) { item in
                            if let image = images.first(where: { $0.id == item.id }) {
                                VStack(alignment: .leading, spacing: 4) {
                                    Thumb(url: URL(string: image.originalUrl), size: 96)
                                    Text(item.purpose.rawValue.capitalized)
                                        .font(.caption).foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                }
                .scrollIndicators(.hidden)
                ForEach(group.images, id: \.id) { item in
                    if let image = images.first(where: { $0.id == item.id }),
                        let text = image.recognizedText, !text.isEmpty
                    {
                        DisclosureGroup("Text read from \(item.purpose.rawValue) photo") {
                            Text(text).font(.caption).textSelection(.enabled)
                            Text("Check the photo before using unclear letters as a size or model.")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
            }
            Section {
                Text(
                    "Database name search suggests these products. Size and color below come from Product titles, not photo analysis. Check the label before choosing."
                )
                .font(.subheadline).foregroundStyle(.secondary)
            }
            if loading { ProgressView("Finding products…") }
            if let error {
                Section {
                    InlineLoadFailure(message: error) { await load() }
                }
            }
            Section("Possible matches") {
                ForEach(candidates, id: \.id) { candidate in
                    HStack(alignment: .top) {
                        Thumb(url: candidate.coverUrl.flatMap(URL.init(string:)), size: 56)
                        VStack(alignment: .leading, spacing: 4) {
                            Text(candidate.name).font(.headline)
                            variantFacts(candidate)
                            Text(reasons(candidate)).font(.caption).foregroundStyle(.secondary)
                            Button("Use this product") {
                                previewCandidate = candidate
                            }
                            .disabled(choosing)
                        }
                    }
                    .padding(.vertical, FieldGuideTokens.Space.xs)
                }
                if !loading && candidates.isEmpty && error == nil {
                    Text("No likely existing products found.").foregroundStyle(.secondary)
                }
            }
            Section {
                Button("Search all products", systemImage: "magnifyingglass") {
                    searchingAll = true
                }
                .disabled(choosing)
            }
        }
        .navigationTitle("Possible matches")
        #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
        #endif
        .task(id: group.groupKey) { await load() }
        .sheet(isPresented: $searchingAll) {
            EntityPickerSheet(target: .product) { picks in
                guard let product = picks.first else { return }
                Task { await choose(productID: ProductCode(product.id)) }
            }
        }
        .sheet(
            isPresented: Binding(
                get: { previewCandidate != nil },
                set: { if !$0 { previewCandidate = nil } })
        ) {
            if let candidate = previewCandidate {
                NavigationStack {
                    List {
                        Section("What this choice keeps") {
                            LabeledContent("Product name", value: candidate.name)
                            LabeledContent("Product details", value: "Existing values stay")
                            LabeledContent("Existing photos", value: "Keep all")
                        }
                        Section("What this choice adds") {
                            LabeledContent(
                                "Your photos", value: "\(group.images.count) attached after approval")
                            LabeledContent("Photo proposal", value: proposalName)
                            Text(
                                "The proposed name and details will not replace the existing Product. Check size and color before continuing."
                            )
                            .font(.footnote).foregroundStyle(.secondary)
                        }
                        Section("Variant check") {
                            variantFacts(candidate)
                        }
                    }
                    .navigationTitle("Use existing product")
                    #if os(iOS)
                        .navigationBarTitleDisplayMode(.inline)
                    #endif
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) {
                            Button("Cancel") { previewCandidate = nil }
                        }
                        ToolbarItem(placement: .confirmationAction) {
                            Button("Use product") {
                                Task { await choose(productID: candidate.id) }
                            }
                            .disabled(choosing)
                        }
                    }
                }
            }
        }
    }

    private var proposalName: String {
        switch group.product {
        case .create(let proposal): proposal.create.name
        case .existing: "Existing Product"
        }
    }

    private func variantFacts(_ candidate: PhotoProductCandidate) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            variantLine(
                "Color", first: candidate.match.variant.color.first,
                second: candidate.match.variant.color.second,
                relation: candidate.match.variant.color.relation.rawValue)
            variantLine(
                "Size", first: candidate.match.variant.size.first,
                second: candidate.match.variant.size.second,
                relation: candidate.match.variant.size.relation.rawValue)
        }
        .font(.caption)
    }

    private func variantLine(
        _ title: String, first: String?, second: String?, relation: String
    ) -> some View {
        let detail =
            relation == "same"
            ? "\(first ?? "Unknown") in both titles"
            : "Proposal: \(first ?? "unknown") · Product: \(second ?? "unknown")"
        return HStack(alignment: .firstTextBaseline) {
            Text("\(title): \(detail)")
                .foregroundStyle(relation == "different" ? FieldGuideTokens.warning : .secondary)
            if relation == "different" {
                Image(systemName: "exclamationmark.triangle")
                    .foregroundStyle(FieldGuideTokens.warning)
            }
        }
    }

    private func reasons(_ candidate: PhotoProductCandidate) -> String {
        var values = ["Database search"]
        if candidate.match.brandMatches { values.append("same brand") }
        if !candidate.match.sharedNameTerms.isEmpty {
            values.append("shared: \(candidate.match.sharedNameTerms.joined(separator: ", "))")
        }
        if candidate.hasPurchase { values.append("purchase linked") }
        if candidate.hasInventory { values.append("in inventory") }
        values.append(candidate.hasOwnPhoto ? "own photo" : "no own photo")
        values.append(candidate.hasPhotoImport ? "previous photo import" : "no previous photo import")
        return values.joined(separator: " · ")
    }

    private func load() async {
        loading = true
        error = nil
        defer { loading = false }
        do {
            candidates = try await appModel.client.photoProductCandidates(
                .init(runId: runID, groupKey: group.groupKey)
            ).candidates
        } catch {
            Diagnostics.report(error, context: "Find photo product matches")
            self.error = error.localizedDescription
        }
    }

    private func choose(productID: ProductCode) async {
        choosing = true
        defer { choosing = false }
        do {
            _ = try await appModel.client.choosePhotoGroupProduct(
                .init(runId: runID, groupKey: group.groupKey, productId: productID))
            onChosen()
            dismiss()
        } catch {
            Diagnostics.report(error, context: "Choose existing product for photo group")
            self.error = error.localizedDescription
        }
    }
}

#if DEBUG
    #Preview("Possible matches", traits: .modifier(SignedInPreview())) {
        if let review = RunReviewPreviewFixture.model().review,
            let group = review.review.proposals.first
        {
            NavigationStack {
                PhotoCandidateSelectionView(
                    runID: RunReviewPreviewFixture.runID, group: group, images: review.images
                ) {}
            }
        }
    }
#endif
