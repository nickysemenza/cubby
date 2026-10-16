import CubbyKit
import SwiftUI

struct PhotoGroupDecisionView: View {
    let runID: String
    let group: PhotoGroupProposal
    let images: [PhotoRunImage]
    let session: RunReviewSession

    @Environment(AppModel.self) private var appModel
    @State private var evidence: PhotoProductEvidence?
    @State private var evidenceError: String?
    @State private var loadingEvidence = false
    @State private var reply = ""
    @State private var actionError: String?
    @State private var saving = false

    private var creating: Bool { PhotoReviewPolicy.isCreate(group: group) }
    private var selectedProductID: ProductCode? {
        if case .existing(let product) = group.product { return product.existing?.id }
        return nil
    }
    private var candidateResult: PhotoCandidateGroupResult? { session.candidateGroups[group.groupKey] }
    private var checks: [PhotoFieldCrossCheck] {
        if candidateResult?.selectedComparison?.id == selectedProductID {
            return candidateResult?.selectedComparison?.crossCheck ?? group.crossCheck ?? []
        }
        return group.crossCheck ?? []
    }

    var body: some View {
        VStack(alignment: .leading, spacing: FieldGuideTokens.Space.sm) {
            Text(creating ? "＋ New" : "↪ Attach")
                .font(.caption.weight(.semibold))
                .foregroundStyle(creating ? Color("ActionCreate") : Color("Slate"))
                .padding(.horizontal, FieldGuideTokens.Space.sm)
                .padding(.vertical, FieldGuideTokens.Space.xs)
                .background(creating ? Color("ActionCreateSurface") : Color("Inset"), in: Capsule())
            if session.checkingCandidates { ProgressView("Checking existing Products…") }
            if let error = candidateResult?.error ?? session.candidatesError {
                Text("Couldn't check · \(error)").font(.caption).textSelection(.enabled)
                Button("Retry candidate check") {
                    Task { await session.loadCandidates(runID: runID, client: appModel.client, force: true) }
                }
                .frame(minHeight: 44)
            }
            if creating,
                let closest = candidateResult?.candidates.first(where: {
                    $0.duplicateStrength?.rawValue == "strong"
                })
                    ?? candidateResult?.candidates.first
            {
                if closest.duplicateStrength?.rawValue == "strong" {
                    Label("Possible duplicate: \(closest.name)", systemImage: "exclamationmark.triangle")
                        .font(.subheadline).foregroundStyle(FieldGuideTokens.warning)
                } else {
                    Text("Closest existing: \(closest.name)").font(.caption).foregroundStyle(.secondary)
                }
            }
            if candidateResult?.candidates.first != nil {
                NavigationLink("Compare") {
                    PhotoCandidateSelectionView(runID: runID, group: group, images: images) {
                        Task { await reload() }
                    }
                }
                .frame(minHeight: 44)
            }
            DecisionSteps(
                steps: group.steps, media: { photoLabel },
                stepBody: { step, next in
                    switch step.key {
                    case "product": productStep
                    case "identity": identityStep(next: next)
                    case "ownership": ownershipStep
                    default: Text(step.summary ?? step.blockedReason ?? "")
                    }
                })
            if let actionError {
                Text(actionError).font(.caption).foregroundStyle(FieldGuideTokens.destructive)
                    .textSelection(.enabled)
            }
        }
        .buttonStyle(PhotoReviewActionStyle())
        .disabled(saving || session.busy)
        .task(id: selectedProductID) { await loadEvidence() }
    }

    private var photoLabel: some View {
        VStack(alignment: .leading, spacing: FieldGuideTokens.Space.sm) {
            ScrollView(.horizontal) {
                HStack(alignment: .top, spacing: FieldGuideTokens.Space.sm) {
                    ForEach(group.images, id: \.id) { item in
                        if let image = images.first(where: { $0.id == item.id }) {
                            Thumb(url: URL(string: image.originalUrl), size: 112)
                                .accessibilityLabel("\(item.purpose.rawValue) photo")
                        }
                    }
                }
            }
            .scrollIndicators(.hidden)
            ForEach(group.images, id: \.id) { item in
                if let image = images.first(where: { $0.id == item.id }),
                    let text = image.recognizedText, !text.isEmpty
                {
                    Text(text).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                        .accessibilityLabel("Label text: \(text)")
                }
            }
        }
    }

    private var productStep: some View {
        VStack(alignment: .leading, spacing: FieldGuideTokens.Space.sm) {
            ForEach(candidateResult?.candidates ?? [], id: \.id) { candidate in
                HStack(alignment: .top) {
                    Thumb(url: candidate.coverUrl.flatMap(URL.init(string:)), size: 44)
                    VStack(alignment: .leading) {
                        Text(candidate.name).font(.subheadline)
                        Button("Use this Product") { choose(candidate.id) }.frame(minHeight: 44)
                        Button("Not this one…") { reject(candidate.id) }.frame(minHeight: 44)
                    }
                }
            }
            ForEach(candidateResult?.rejectedCandidates ?? [], id: \.id) { rejected in
                Text("Rejected: \(rejected.name)").font(.caption).foregroundStyle(.secondary)
            }
            NavigationLink {
                PhotoCandidateSelectionView(runID: runID, group: group, images: images) {
                    Task { await reload() }
                }
            } label: {
                Label("Compare / search Products", systemImage: "magnifyingglass").frame(minHeight: 44)
            }
            if creating {
                NavigationLink {
                    PhotoGroupDraftEditView(runID: runID, group: group) { Task { await reload() } }
                } label: {
                    Label("Edit proposed Product", systemImage: "pencil").frame(minHeight: 44)
                }
            }
        }
    }

    private func identityStep(next: @escaping () -> Void) -> some View {
        VStack(alignment: .leading, spacing: FieldGuideTokens.Space.sm) {
            if let observed = group.review?.observedName {
                Text("Label: \(observed)").font(.subheadline)
            }
            Text("Product: \(productName)").font(.subheadline)
            if let description = group.evidence {
                Text(description).font(.caption).foregroundStyle(.secondary)
            }
            if candidateResult?.selectedComparison?.id == selectedProductID,
                let variant = candidateResult?.selectedComparison?.variant
            {
                Text("Label evidence: \(variant.evidence.firstTitle)").font(.caption)
                Text("Product evidence: \(variant.evidence.secondTitle)").font(.caption)
            }
            ForEach(checks, id: \.field) { check in
                let mark = PhotoReviewPolicy.crossCheckMark(check)
                HStack(alignment: .top, spacing: FieldGuideTokens.Space.sm) {
                    Text(mark).fontWeight(.semibold)
                        .foregroundStyle(mark == "!" ? FieldGuideTokens.warning : .secondary)
                    Text(check.field.rawValue.capitalized)
                    Text(check.tokens.map(\.text).joined(separator: " · "))
                        .foregroundStyle(.secondary)
                }
                .font(.caption)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(
                    "\(check.field.rawValue): \(mark == "✓" ? "Agrees" : mark == "!" ? "Disagrees or missing" : "Unknown"), \(check.tokens.map(\.text).joined(separator: ", "))"
                )
            }
            if checks.isEmpty {
                Text("? Field evidence unavailable").font(.caption).foregroundStyle(.secondary)
            }
            memoryJoggers
            if let concern = group.review?.unresolvedReason,
                group.steps.first(where: { $0.key == "identity" })?.summary == concern
            {
                Text("Agent's concern").font(.caption.weight(.semibold))
                Text(concern).font(.subheadline).textSelection(.enabled)
                TextField("Optional one-line reply", text: $reply)
                    .textFieldStyle(.roundedBorder).frame(minHeight: 44)
                Button("Resolved") { resolveConcern() }.frame(minHeight: 44)
                    .disabled(reply.count > 500 || reply.contains("\n") || reply.contains("\r"))
            }
            Button("Yes, this is it", action: next).frame(minHeight: 44)
                .disabled(group.steps.first(where: { $0.key == "identity" })?.summary != nil)
            if let productID = selectedProductID {
                Button("Not this one…") { reject(productID) }.frame(minHeight: 44)
            }
        }
    }

    private var ownershipStep: some View {
        VStack(alignment: .leading, spacing: FieldGuideTokens.Space.sm) {
            if let inventory = group.inventory {
                Text("Yes · \(inventory.quantity) at \(inventory.locationName ?? "Choose a location")")
            } else {
                Text("Reference only · no inventory change")
            }
            NavigationLink {
                PhotoGroupOwnershipEditView(runID: runID, group: group) { Task { await reload() } }
            } label: {
                Text("Change ownership / inventory").frame(minHeight: 44).contentShape(.rect)
            }
        }
    }

    @ViewBuilder private var memoryJoggers: some View {
        if loadingEvidence { ProgressView("Loading Product evidence…") }
        if let evidenceError {
            Text(evidenceError).font(.caption).textSelection(.enabled)
            Button("Retry evidence") { Task { await loadEvidence() } }.frame(minHeight: 44)
        }
        if let evidence {
            VStack(alignment: .leading, spacing: FieldGuideTokens.Space.sm) {
                if let manufacturer = evidence.manufacturer { Text("Manufacturer: \(manufacturer)") }
                if let model = evidence.model { Text("Model: \(model)") }
                if !evidence.identifiers.isEmpty { Text(evidence.identifiers.joined(separator: " · ")) }
                ForEach(evidence.purchaseLines ?? [], id: \.expenseId) { line in
                    VStack(alignment: .leading, spacing: 2) {
                        HStack {
                            Text(line.dateLabel?.rawValue ?? "Paid")
                            if let date = line.date { DateDisplay(date) }
                        }
                        Text(
                            [
                                line.vendor, line.cost.map { DisplayFormat.currency($0) },
                                line.productQuantity.map { "+\(DisplayFormat.number($0))" },
                            ]
                            .compactMap { $0 }.joined(separator: " · "))
                    }
                }
                if let quantity = evidence.quantity?.onHandUnits {
                    Text("On hand: \(DisplayFormat.number(quantity))")
                } else {
                    Text("On hand: not counted")
                }
                if (evidence.purchaseLines ?? []).isEmpty { Text("No purchase evidence") }
                if (evidence.ownPhotos ?? []).isEmpty { Text("No own photos") }
                ForEach(evidence.inventoryEntries ?? [], id: \.id) { entry in
                    Text(entry.location.name)
                }
                ScrollView(.horizontal) {
                    HStack(alignment: .top, spacing: FieldGuideTokens.Space.sm) {
                        ForEach(evidence.ownPhotos ?? [], id: \.id) { photo in
                            VStack(alignment: .leading, spacing: 2) {
                                Thumb(url: URL(string: photo.url), size: 72)
                                if let date = photo.capturedAt {
                                    Text("Taken")
                                    DateDisplay(date)
                                } else {
                                    Text("Capture date unknown")
                                }
                            }
                            .frame(maxWidth: 160, alignment: .leading)
                        }
                    }
                }
            }
            .font(.caption).foregroundStyle(.secondary)
        }
    }

    private var productName: String {
        switch group.product {
        case .create(let product): product.create.name
        case .existing(let product): product.existing?.name ?? "Missing Product"
        }
    }

    private func loadEvidence() async {
        evidence = nil
        evidenceError = nil
        guard let productID = selectedProductID else { return }
        loadingEvidence = true
        defer { loadingEvidence = false }
        do {
            let loaded = try await appModel.client.photoEvidence(runID: runID, productID: productID)
            try Task.checkCancellation()
            evidence = loaded
        } catch is CancellationError {
        } catch {
            Diagnostics.report(error, context: "Load photo Product evidence")
            evidenceError = error.localizedDescription
        }
    }

    private func reload() async {
        await session.refresh(runID: runID, client: appModel.client)
        await session.loadCandidates(runID: runID, client: appModel.client, force: true)
    }

    private func choose(_ productID: ProductCode) {
        mutate {
            _ = try await appModel.client.choosePhotoGroupProduct(
                .init(runId: runID, groupKey: group.groupKey, productId: productID))
        }
    }

    private func reject(_ productID: ProductCode) {
        mutate {
            try await appModel.client.rejectPhotoCandidate(
                runID: runID, groupKey: group.groupKey, productID: productID)
        }
    }

    private func resolveConcern() {
        mutate {
            try await appModel.client.resolvePhotoConcern(runID: runID, group: group, reply: reply)
            reply = ""
        }
    }

    private func mutate(_ operation: @escaping @MainActor () async throws -> Void) {
        saving = true
        actionError = nil
        Task {
            defer { saving = false }
            do {
                try await operation()
                await reload()
            } catch {
                Diagnostics.report(error, context: "Update photo review")
                actionError = error.localizedDescription
            }
        }
    }
}

#if DEBUG
    #Preview("Photo group decisions", traits: .modifier(SignedInPreview())) {
        let session = RunReviewPreviewFixture.model()
        if let review = session.review, let group = review.review.proposals.first {
            NavigationStack {
                PhotoGroupDecisionView(
                    runID: RunReviewPreviewFixture.runID, group: group,
                    images: review.images, session: session
                )
                .padding(FieldGuideTokens.Space.md)
            }
        }
    }
#endif

/// Borderless List controls need the target inside the rendered label.
private struct PhotoReviewActionStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .frame(minHeight: 44, alignment: .leading)
            .contentShape(.rect)
            .foregroundStyle(Color.accentColor)
            .opacity(configuration.isPressed ? 0.6 : 1)
    }
}
