import CubbyKit
import Observation
import SwiftUI

/// One review surface for routing, staging, and atomically committing a selected photo batch.
struct PhotoDestinationSheet: View {
    @Environment(AppModel.self) private var appModel
    @Environment(\.dismiss) private var dismiss
    let onDone: ([String]) -> Void
    @State private var manifest: PhotoImportManifest
    @State private var search = ""
    @State private var path: [String] = []
    @State private var replacement: ReplacementConfirmation?
    @State private var createContext: PhotoCreateContext?
    @State private var relatedContext: PhotoRelatedContext?

    init(items: [PhotoSelectionItem], onDone: @escaping ([String]) -> Void) {
        self.onDone = onDone
        _manifest = State(initialValue: PhotoImportManifest(items: items))
    }

    var body: some View {
        NavigationStack(path: $path) {
            VStack(alignment: .leading, spacing: 0) {
                selectedStrip
                List {
                    if !manifest.filteredNeedsDestination(search).isEmpty {
                        Section("Needs a destination") {
                            PhotoImportGroupRows(
                                ids: manifest.filteredNeedsDestination(search), manifest: manifest)
                        }
                    }
                    ForEach(
                        manifest.groups.filter {
                            search.isEmpty || $0.title.localizedCaseInsensitiveContains(search)
                        }
                    ) { group in
                        Section {
                            PhotoImportGroupRows(ids: group.photoIDs, manifest: manifest)
                        } header: {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(group.title)
                                if let evidence = group.evidence {
                                    Text(evidence).font(.caption).foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                }
                disclosure
                footer
            }
            .navigationTitle("Review photos")
            .searchable(text: $search, prompt: "Search destinations")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .automatic) {
                    HStack {
                        if manifest.canUndo {
                            Button("Undo", systemImage: "arrow.uturn.backward") {
                                manifest.undoLastMove()
                            }
                            .keyboardShortcut("z", modifiers: .command)
                            .accessibilityIdentifier("photos.manifest.undo")
                        }
                        Menu("Move to…", systemImage: "folder") {
                            ForEach(manifest.destinationOptions) { option in
                                Button(option.title) { path.append(option.id) }
                            }
                        }
                        .disabled(manifest.selectedIDs.isEmpty)
                    }
                }
            }
            .navigationDestination(for: String.self) { routeID in
                if let option = manifest.destinationOptions.first(where: { $0.id == routeID }) {
                    if option.route.kind == "createRelated" {
                        PhotoEntityChooser(
                            key: option.route.source,
                            captureDates: manifest.selectedItems.map(\.capturedAt)
                        ) { row in
                            createContext = PhotoCreateContext(option: option, source: row)
                        }
                    } else if option.route.kind == "existingRelated" {
                        PhotoEntityChooser(
                            key: option.route.source,
                            captureDates: manifest.selectedItems.map(\.capturedAt)
                        ) { row in
                            relatedContext = PhotoRelatedContext(option: option, source: row)
                        }
                    } else {
                        PhotoEntityChooser(
                            key: option.descriptor.key,
                            captureDates: manifest.selectedItems.map(\.capturedAt)
                        ) { row in
                            if option.route.requiresReplaceConfirmation, row.imageURL != nil {
                                replacement = ReplacementConfirmation(option: option, row: row)
                            } else {
                                manifest.moveSelected(to: option, row: row)
                                path.removeLast()
                            }
                        }
                    }
                }
            }
        }
        .nativeSheet(.photo)
        .interactiveDismissDisabled(manifest.isCommitting)
        .task {
            await manifest.analyze(client: appModel.client, matches: appModel.photoMatches)
        }
        .confirmationDialog(
            "Replace the existing image?", item: $replacement,
            titleVisibility: .visible
        ) { confirmation in
            Button("Replace", role: .destructive) {
                manifest.moveSelected(to: confirmation.option, row: confirmation.row, replace: true)
                path.removeLast()
            }
            Button("Cancel", role: .cancel) {}
        } message: { confirmation in
            Text(
                "\(confirmation.row.title) already has an image. This photo will replace it when the batch is added."
            )
        }
        .sheet(item: $createContext) { context in
            PhotoRelatedCreateEditor(
                option: context.option,
                source: context.source,
                captureDate: manifest.selectedItems.compactMap(\.capturedAt).min()
            ) { body in
                manifest.stageCreate(
                    option: context.option, source: context.source, body: body)
                createContext = nil
                if !path.isEmpty { path.removeLast() }
            }
        }
        .sheet(item: $relatedContext) { context in
            PhotoRelatedDestinationChooser(context: context) { row in
                manifest.moveSelected(to: context.option, source: context.source, destination: row)
                relatedContext = nil
                if !path.isEmpty { path.removeLast() }
            }
            .environment(appModel)
        }
    }

    private var selectedStrip: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(manifest.items) { item in
                    Image(decorative: item.preview, scale: 1).resizable().scaledToFill()
                        .frame(width: 64, height: 64).clipShape(RoundedRectangle(cornerRadius: 10))
                        .overlay(alignment: .topTrailing) {
                            if manifest.selectedIDs.contains(item.id) {
                                Image(systemName: "checkmark.circle.fill").foregroundStyle(.white, .blue)
                                    .padding(3)
                            }
                        }
                        .onTapGesture { manifest.toggle(item.id) }
                        .accessibilityLabel(
                            "Photo \(manifest.items.firstIndex(where: { $0.id == item.id }).map { $0 + 1 } ?? 0)"
                        )
                        .accessibilityAddTraits(manifest.selectedIDs.contains(item.id) ? .isSelected : [])
                }
            }.padding(.horizontal, 16).padding(.vertical, 12)
        }.background(.bar)
    }

    private var disclosure: some View {
        DisclosureGroup("On-device analysis") {
            VStack(alignment: .leading, spacing: 4) {
                Label("Vision image classification", systemImage: "eye")
                Label("Vision text recognition", systemImage: "text.viewfinder")
                Label("Vision feature print", systemImage: "point.3.connected.trianglepath.dotted")
                Label("Capture metadata and date", systemImage: "calendar")
                if let foundationModelSummary = manifest.foundationModelSummary {
                    Label(foundationModelSummary, systemImage: "apple.intelligence")
                }
                Text("No cloud AI is used. Derived analysis data syncs to Cubby.")
                    .foregroundStyle(.secondary)
            }
            .padding(.top, 4)
        }
        .font(.caption)
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
    }

    private var footer: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let error = manifest.errorMessage {
                Label(error, systemImage: "exclamationmark.triangle")
                    .font(.caption)
                    .foregroundStyle(PorcelainTokens.destructive)
            }
            HStack {
                Text("\(manifest.items.count) photo\(manifest.items.count == 1 ? "" : "s")")
                Spacer()
                Button(manifest.isCommitting ? manifest.progress : "Add \(manifest.items.count) photos") {
                    Task {
                        guard let committedIDs = await manifest.commit(client: appModel.client) else {
                            return
                        }
                        await appModel.photoMatches.refresh(client: appModel.client)
                        onDone(committedIDs)
                        dismiss()
                    }
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .disabled(!manifest.canCommit)
                .accessibilityIdentifier("photos.manifest.add")
            }
        }.padding(16).background(.bar)
    }
}

@MainActor
@Observable
final class PhotoImportManifest {
    let items: [PhotoSelectionItem]
    var selectedIDs: Set<String>
    private var assignments: [String: PhotoDestinationAssignment] = [:]
    private(set) var isCommitting = false
    private(set) var progress = "Preparing…"
    private(set) var errorMessage: String?
    private(set) var suggestions: [String: String] = [:]
    private(set) var foundationModelSummary: String?
    private(set) var duplicateCandidates: [String: [DedupCandidate]] = [:]
    private(set) var duplicateOwnerShortcodes: [String: [String]] = [:]
    private var duplicateDecisions: [String: PhotoDuplicateDecision] = [:]
    private var undoSnapshot: [PhotoUndoAssignment] = []
    private var prepared: [String: (PhotoFile, PhotoLocalAnalysis)] = [:]
    private var transaction: PhotoImportTransaction?

    init(items: [PhotoSelectionItem]) {
        self.items = items
        selectedIDs = Set(items.map(\.id))
    }

    var destinationOptions: [PhotoDestinationOption] {
        PhotoImportCatalog.ingressRoutes
            .filter { $0.storage != nil }
            .map { PhotoDestinationOption(route: $0, descriptor: EntityCatalog[$0.target]) }
            .sorted { $0.menuTitle < $1.menuTitle }
    }

    var selectedItems: [PhotoSelectionItem] {
        items.filter { selectedIDs.contains($0.id) }
    }

    var needsDestination: [String] {
        items.map(\.id).filter { assignments[$0] == nil }
    }

    func filteredNeedsDestination(_ query: String) -> [String] {
        guard !query.isEmpty else { return needsDestination }
        return needsDestination.filter { id in
            items.first(where: { $0.id == id })?.capturedAt?.formatted().localizedCaseInsensitiveContains(
                query) == true
        }
    }

    var groups: [PhotoImportGroup] {
        Dictionary(
            grouping: items.compactMap { item -> (PhotoSelectionItem, PhotoDestinationAssignment)? in
                guard let assignment = assignments[item.id] else { return nil }
                return (item, assignment)
            }, by: { $0.1.id }
        ).values.compactMap { values in
            guard let first = values.first else { return nil }
            return PhotoImportGroup(
                id: first.1.id,
                title: "\(first.1.title)  \(first.1.shortcode)",
                evidence: first.1.evidence,
                photoIDs: values.map { $0.0.id })
        }.sorted { $0.title < $1.title }
    }

    var canCommit: Bool {
        !items.isEmpty && needsDestination.isEmpty && unresolvedDuplicateIDs.isEmpty && !isCommitting
    }

    var unresolvedDuplicateIDs: [String] {
        duplicateCandidates.keys.filter { duplicateDecisions[$0] == nil }.sorted()
    }

    var canUndo: Bool { !undoSnapshot.isEmpty }

    func analyze(client: CubbyClient, matches: PhotoMatchStore) async {
        do {
            try await prepareIfNeeded()
            do {
                try await matches.check(items, client: client)
                for item in items {
                    let candidates = Self.uniqueCandidates(matches.storedCandidates(for: item.id))
                    if !candidates.isEmpty {
                        duplicateCandidates[item.id] = candidates
                        for candidate in candidates {
                            duplicateOwnerShortcodes[candidate.id.rawValue] =
                                matches.directOwnerShortcodes(for: candidate.id)
                        }
                    }
                }
            } catch is CancellationError {
                throw CancellationError()
            } catch {
                Diagnostics.report(error, context: "photos.manifest.identity")
            }
            let candidates = await loadCandidates(client: client)
            guard !candidates.isEmpty else { return }
            let evidence = items.compactMap { item -> PhotoRoutingEvidence? in
                guard let analysis = prepared[item.id]?.1 else { return nil }
                let owners = matches.strongDirectOwnerShortcodes(for: item.id)
                let candidateIDs = deterministicCandidateIDs(
                    for: analysis, authoritativeOwners: Set(owners), among: candidates)
                return PhotoRoutingEvidence(
                    photoID: item.id,
                    summary: evidenceSummary(analysis, authoritativeOwners: owners),
                    deterministicCandidateIDs: candidateIDs)
            }
            let result = try await PhotoSemanticReranker().rerank(
                evidence: evidence, candidates: candidates.map(\.routing))
            foundationModelSummary = Self.foundationModelSummary(result.modelStatus)
            let byID = Dictionary(uniqueKeysWithValues: candidates.map { ($0.row.id, $0) })
            for decision in result.decisions {
                guard assignments[decision.photoID] == nil,
                    let candidateID = decision.candidateID,
                    let candidate = byID[candidateID],
                    candidate.option.id == decision.routeID
                else { continue }
                assignments[decision.photoID] = PhotoDestinationAssignment(
                    route: candidate.option.route,
                    source: EntityRef(entity: candidate.option.route.source, id: candidate.row.id),
                    recordID: candidate.row.id,
                    title: candidate.row.title,
                    shortcode: candidate.row.id,
                    replaceConfirmed: false,
                    evidence: decision.explanation)
                suggestions[decision.photoID] = decision.explanation
                selectedIDs.remove(decision.photoID)
            }
            for item in items where assignments[item.id] == nil {
                if let analysis = prepared[item.id]?.1,
                    let suggestion = suggestedDestination(for: analysis)
                {
                    suggestions[item.id] = suggestion
                }
            }
        } catch is CancellationError {
            return
        } catch {
            Diagnostics.report(error, context: "photos.manifest.analysis")
        }
    }

    func toggle(_ id: String) {
        if selectedIDs.contains(id) { selectedIDs.remove(id) } else { selectedIDs.insert(id) }
    }

    func chooseExisting(_ imageID: ImageCode, for itemID: String) {
        duplicateDecisions[itemID] = .reuse(imageID)
    }

    func chooseNew(for itemID: String) {
        duplicateDecisions[itemID] = .keepBoth
    }

    func duplicateSelection(_ itemID: String) -> PhotoDuplicateDecision? {
        duplicateDecisions[itemID]
    }

    func duplicateLabel(_ candidate: DedupCandidate) -> String {
        let owners = duplicateOwnerShortcodes[candidate.id.rawValue] ?? []
        return owners.isEmpty
            ? candidate.id.rawValue : (PhotoGridBadge.text(for: owners) ?? candidate.id.rawValue)
    }

    func moveSelected(to option: PhotoDestinationOption, row: EntityRow, replace: Bool = false) {
        rememberMove()
        let assignment = PhotoDestinationAssignment(
            route: option.route, source: EntityRef(entity: option.route.source, id: row.id),
            recordID: row.id, title: row.title,
            shortcode: row.id, replaceConfirmed: replace, evidence: "Assigned manually")
        for id in selectedIDs { assignments[id] = assignment }
        selectedIDs.removeAll()
    }

    func moveSelected(
        to option: PhotoDestinationOption, source: EntityRow, destination: EntityRow
    ) {
        rememberMove()
        let assignment = PhotoDestinationAssignment(
            route: option.route,
            source: EntityRef(entity: option.route.source, id: source.id),
            recordID: destination.id,
            title: destination.title,
            shortcode: destination.id,
            replaceConfirmed: false,
            evidence: "Related to \(source.title)")
        for id in selectedIDs { assignments[id] = assignment }
        selectedIDs.removeAll()
    }

    func stageCreate(
        option: PhotoDestinationOption, source: EntityRow, body: [String: JSONValue]
    ) {
        rememberMove()
        let captureDate = selectedItems.compactMap(\.capturedAt).min()
        let draft = PhotoCreateDraft(
            id: "photo-import-\(UUID().uuidString)", route: option.route,
            source: EntityRef(entity: option.route.source, id: source.id), body: body,
            title: "New \(option.descriptor.singular) from \(source.title)",
            captureDate: captureDate)
        let assignment = PhotoDestinationAssignment(
            route: option.route, source: draft.source, recordID: nil, title: draft.title, shortcode: "New",
            replaceConfirmed: false, evidence: "Staged from \(source.title)", createDraft: draft)
        for id in selectedIDs { assignments[id] = assignment }
        selectedIDs.removeAll()
    }

    func undoLastMove() {
        guard !undoSnapshot.isEmpty else { return }
        let snapshot = undoSnapshot
        for item in snapshot { assignments[item.photoID] = item.assignment }
        selectedIDs = Set(snapshot.map(\.photoID))
        undoSnapshot = []
    }

    func commit(client: CubbyClient) async -> [String]? {
        guard canCommit else { return nil }
        isCommitting = true
        errorMessage = nil
        progress = "Adding photos…"
        defer { isCommitting = false }
        do {
            try await prepareIfNeeded()
            let batch = try items.map { item -> PhotoImportBatchItem in
                guard let assignment = assignments[item.id],
                    let (file, analysis) = prepared[item.id]
                else { throw PhotoImportManifestError.incompleteAssignment }
                if let draft = assignment.createDraft {
                    return PhotoImportBatchItem(
                        clientID: item.id, file: file, analysis: analysis,
                        routeID: assignment.route.id,
                        sourceEntity: assignment.source.entity,
                        sourceID: assignment.source.id,
                        draftID: draft.id,
                        draftRouteID: draft.route.id, draftBody: draft.body,
                        draftCapturedAt: draft.captureDate,
                        replaceConfirmed: assignment.replaceConfirmed,
                        duplicateChoice: duplicateChoice(for: item.id))
                }
                guard let recordID = assignment.recordID else {
                    throw PhotoImportManifestError.incompleteAssignment
                }
                return PhotoImportBatchItem(
                    clientID: item.id, file: file, analysis: analysis,
                    routeID: assignment.route.id,
                    sourceEntity: assignment.source.entity,
                    sourceID: assignment.source.id,
                    candidateID: recordID,
                    replaceConfirmed: assignment.replaceConfirmed,
                    duplicateChoice: duplicateChoice(for: item.id))
            }
            let transaction = transaction ?? PhotoImportTransaction(client: client)
            self.transaction = transaction
            let receipt = try await transaction.commit(batch) { [weak self] state in
                Task { @MainActor in self?.updateProgress(state) }
            }
            return receipt.committedClientIds
        } catch {
            errorMessage = error.localizedDescription
            progress = "Try again"
            Diagnostics.report(error, context: "photos.manifest.commit")
            return nil
        }
    }

    private func prepareIfNeeded() async throws {
        let missing = items.filter { prepared[$0.id] == nil }
        guard !missing.isEmpty else { return }
        var files: [PhotoFile] = []
        for (index, item) in missing.enumerated() {
            progress = "Preparing photo \(index + 1) of \(missing.count)…"
            files.append(try await item.materialize())
        }
        progress = "Analyzing on device…"
        let analyses = try await LocalPhotoAnalyzer().analyze(
            zip(missing, files).map { item, file in
                PhotoAnalysisInput(
                    id: item.id, file: file,
                    provenance: PhotoAnalysisProvenance(
                        source: item.provenanceSource,
                        localIdentifier: item.localIdentifier,
                        filename: file.filename))
            })
        for (index, item) in missing.enumerated() {
            prepared[item.id] = (files[index], analyses[index])
        }
    }

    private func updateProgress(_ state: PhotoImportTransactionProgress) {
        switch state {
        case .staging: progress = "Staging photos…"
        case .uploading(let completed, let total): progress = "Uploading \(completed) of \(total)…"
        case .committing: progress = "Adding photos…"
        }
    }

    private func duplicateChoice(for itemID: String) -> PhotoImportDuplicateChoice {
        switch duplicateDecisions[itemID] {
        case .reuse(let imageID): .reuse(imageID)
        case .keepBoth: .keepBoth
        case nil: .automatic
        }
    }

    private func rememberMove() {
        undoSnapshot = selectedIDs.sorted().map {
            PhotoUndoAssignment(photoID: $0, assignment: assignments[$0])
        }
    }

    private static func uniqueCandidates(_ candidates: [DedupCandidate]) -> [DedupCandidate] {
        var seen = Set<ImageCode>()
        return candidates.filter { seen.insert($0.id).inserted }
    }

    private func suggestedDestination(for analysis: PhotoLocalAnalysis) -> String? {
        let optionsByKey = Dictionary(
            destinationOptions.filter { $0.route.kind == "self" }.map { ($0.route.target, $0) },
            uniquingKeysWith: { first, _ in first })
        let candidates = optionsByKey.compactMap { key, option -> (String, Double, String)? in
            guard let policy = PhotoImportCatalog.routingPolicies[key] else { return nil }
            let match = analysis.classifications
                .filter { classification in
                    let identifier = classification.identifier.lowercased()
                    return policy.classifierLabels.contains {
                        identifier.contains($0.lowercased())
                    }
                }
                .max { $0.confidence < $1.confidence }
            guard let match, match.confidence >= policy.minimumScore else { return nil }
            return (option.descriptor.plural, match.confidence, match.identifier)
        }
        guard let best = candidates.max(by: { $0.1 < $1.1 }) else { return nil }
        return "Suggested: \(best.0) · \(best.2)"
    }

    private struct Candidate {
        let option: PhotoDestinationOption
        let row: EntityRow
        let routing: PhotoRoutingCandidate
    }

    private func loadCandidates(client: CubbyClient) async -> [Candidate] {
        var result: [Candidate] = []
        for option in destinationOptions where option.route.kind == "self" {
            do {
                let page = try await client.list(option.descriptor, page: 1, pageSize: 25)
                let policy = PhotoImportCatalog.routingPolicies[option.route.target]
                for row in page.items
                where Self.matchesLifecycle(row, policy: policy)
                    && !(option.route.requiresReplaceConfirmation && row.imageURL != nil)
                {
                    let description =
                        ([row.title, row.id]
                        + (policy?.candidateFields.compactMap { row.raw[$0]?.stringValue } ?? []))
                        .joined(separator: " · ")
                    result.append(
                        Candidate(
                            option: option,
                            row: row,
                            routing: PhotoRoutingCandidate(
                                id: row.id, routeID: option.id, description: description)))
                }
            } catch {
                Diagnostics.report(error, context: "photos.manifest.candidates.\(option.id)")
            }
        }
        return Array(result.prefix(FoundationModelsPhotoSemanticModel.maximumCandidates))
    }

    private func deterministicCandidateIDs(
        for analysis: PhotoLocalAnalysis,
        authoritativeOwners: Set<String>,
        among candidates: [Candidate]
    ) -> [String] {
        let scored = candidates.compactMap { candidate -> (String, Double, Double)? in
            guard let policy = PhotoImportCatalog.routingPolicies[candidate.option.route.target]
            else { return nil }
            let classifierScore =
                analysis.classifications
                .filter { classification in
                    let identifier = classification.identifier.lowercased()
                    return policy.classifierLabels.contains {
                        identifier.contains($0.lowercased())
                    }
                }
                .map(\.confidence).max() ?? 0
            let searchable =
                ([candidate.row.title]
                + policy.candidateFields.compactMap { candidate.row.raw[$0]?.stringValue })
                .joined(separator: " ").lowercased()
            let textScore = analysis.recognizedText.reduce(0.0) { score, text in
                let recognized = text.text.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
                guard recognized.count >= 3 else { return score }
                return max(score, searchable.contains(recognized) ? 0.96 * text.confidence : 0)
            }
            let capturedDay = analysis.capturedAt.map { PlainDate($0).rawValue }
            let dateScore =
                capturedDay.map { day in
                    policy.temporalFields.contains { field in
                        candidate.row.raw[field]?.stringValue?.hasPrefix(day) == true
                    } ? 0.88 : 0
                } ?? 0
            let identityScore = authoritativeOwners.contains(candidate.row.id) ? 1.0 : 0
            let evidenceScore = max(textScore, dateScore, identityScore)
            let score = min(1, evidenceScore + classifierScore * 0.08)
            return (candidate.row.id, score, policy.minimumScore)
        }.sorted { $0.1 > $1.1 }
        guard let first = scored.first, first.1 >= first.2 else { return [] }
        let policy = candidates.first(where: { $0.row.id == first.0 }).flatMap {
            PhotoImportCatalog.routingPolicies[$0.option.route.target]
        }
        let runnerUp = scored.dropFirst().first?.1 ?? 0
        guard first.1 - runnerUp >= (policy?.minimumMargin ?? 1) else { return [] }
        return scored.prefix(5).filter { $0.1 >= $0.2 }.map(\.0)
    }

    private func evidenceSummary(
        _ analysis: PhotoLocalAnalysis, authoritativeOwners: [String]
    ) -> String {
        let classifications = analysis.classifications.prefix(4).map(\.identifier).joined(separator: ", ")
        let text = analysis.recognizedText.prefix(4).map(\.text).joined(separator: " ")
        let date = analysis.capturedAt?.formatted(date: .abbreviated, time: .omitted) ?? "unknown date"
        let identity =
            authoritativeOwners.isEmpty
            ? "" : " Matched authoritative image: \(authoritativeOwners.sorted().joined(separator: ", "))."
        return
            "Capture date: \(date). Vision labels: \(classifications). Recognized text: \(text).\(identity)"
    }

    private static func matchesLifecycle(_ row: EntityRow, policy: PhotoRoutingPolicy?) -> Bool {
        guard let policy else { return true }
        return policy.lifecycleFilters.allSatisfy { filter in
            if let value = row.raw[filter.field]?.stringValue { return value == filter.equals }
            if let value = row.raw[filter.field]?.boolValue { return String(value) == filter.equals }
            return false
        }
    }

    private static func foundationModelSummary(_ status: PhotoSemanticModelStatus) -> String {
        switch status {
        case .used: "Foundation Models semantic reranking"
        case .unavailable(let reason): "Foundation Models unavailable: \(String(describing: reason))"
        case .failed(let reason): "Foundation Models fallback: \(reason.rawValue)"
        }
    }
}

struct PhotoImportGroup: Identifiable, Equatable {
    let id: String
    let title: String
    let evidence: String?
    let photoIDs: [String]
}

private struct PhotoImportGroupRows: View {
    let ids: [String]
    @Bindable var manifest: PhotoImportManifest

    var body: some View {
        ForEach(ids, id: \.self) { id in
            if let item = manifest.items.first(where: { $0.id == id }) {
                Button {
                    manifest.toggle(id)
                } label: {
                    HStack(spacing: 12) {
                        Image(decorative: item.preview, scale: 1).resizable().scaledToFill()
                            .frame(width: 52, height: 52).clipShape(RoundedRectangle(cornerRadius: 8))
                        VStack(alignment: .leading, spacing: 2) {
                            Text(
                                item.capturedAt?.formatted(date: .abbreviated, time: .shortened)
                                    ?? "Undated photo")
                            if let suggestion = manifest.suggestions[id] {
                                Text(suggestion).font(.caption).foregroundStyle(.secondary)
                            }
                            if let candidates = manifest.duplicateCandidates[id] {
                                Menu {
                                    ForEach(candidates, id: \.id) { candidate in
                                        Button {
                                            manifest.chooseExisting(candidate.id, for: id)
                                        } label: {
                                            Label(
                                                "Use \(manifest.duplicateLabel(candidate))",
                                                systemImage: manifest.duplicateSelection(id)
                                                    == .reuse(candidate.id)
                                                    ? "checkmark.circle.fill" : "circle")
                                        }
                                    }
                                    Divider()
                                    Button {
                                        manifest.chooseNew(for: id)
                                    } label: {
                                        Label(
                                            "Add separately",
                                            systemImage: manifest.duplicateSelection(id) == .keepBoth
                                                ? "checkmark.circle.fill" : "circle")
                                    }
                                } label: {
                                    Label(
                                        manifest.duplicateSelection(id) == nil
                                            ? "Review possible duplicate" : "Duplicate reviewed",
                                        systemImage: manifest.duplicateSelection(id) == nil
                                            ? "exclamationmark.circle" : "checkmark.circle")
                                }
                                .font(.caption)
                                .accessibilityIdentifier("photos.duplicate.\(id)")
                            }
                        }
                        Spacer()
                        Image(
                            systemName: manifest.selectedIDs.contains(id) ? "checkmark.circle.fill" : "circle"
                        )
                        .foregroundStyle(manifest.selectedIDs.contains(id) ? .blue : .secondary)
                    }
                }.buttonStyle(.plain).accessibilityValue(
                    manifest.selectedIDs.contains(id) ? "Selected" : "Not selected")
            }
        }
    }
}

enum PhotoDuplicateDecision: Equatable {
    case reuse(ImageCode)
    case keepBoth
}

private enum PhotoImportManifestError: LocalizedError {
    case incompleteAssignment

    var errorDescription: String? {
        "Choose a destination for every photo before adding the batch."
    }
}

struct PhotoDestinationOption: Identifiable {
    let route: PhotoIngressRoute
    let descriptor: EntityDescriptor
    var id: String { route.id }
    var title: String { descriptor.plural }
    var menuTitle: String {
        switch route.kind {
        case "createRelated":
            "New \(descriptor.singular) from \(EntityCatalog[route.source].singular)"
        case "existingRelated":
            "\(EntityCatalog[route.source].singular) → \(descriptor.plural)"
        default:
            title
        }
    }
}

private struct PhotoCreateContext: Identifiable {
    let option: PhotoDestinationOption
    let source: EntityRow
    var id: String { "\(option.id):\(source.id)" }
}

private struct PhotoRelatedContext: Identifiable {
    let option: PhotoDestinationOption
    let source: EntityRow
    var id: String { "\(option.id):\(source.id)" }
}

private struct PhotoCreateDraft: Sendable {
    let id: String
    let route: PhotoIngressRoute
    let source: EntityRef
    let body: [String: JSONValue]
    let title: String
    let captureDate: Date?
}

private struct PhotoDestinationAssignment: Identifiable {
    let route: PhotoIngressRoute
    let source: EntityRef
    let recordID: String?
    let title: String
    let shortcode: String
    let replaceConfirmed: Bool
    let evidence: String
    let createDraft: PhotoCreateDraft?
    var id: String { "\(route.id):\(createDraft?.id ?? recordID ?? "unassigned")" }

    init(
        route: PhotoIngressRoute,
        source: EntityRef,
        recordID: String?,
        title: String,
        shortcode: String,
        replaceConfirmed: Bool,
        evidence: String,
        createDraft: PhotoCreateDraft? = nil
    ) {
        self.route = route
        self.source = source
        self.recordID = recordID
        self.title = title
        self.shortcode = shortcode
        self.replaceConfirmed = replaceConfirmed
        self.evidence = evidence
        self.createDraft = createDraft
    }
}

private struct PhotoUndoAssignment {
    let photoID: String
    let assignment: PhotoDestinationAssignment?
}

private struct ReplacementConfirmation: Identifiable {
    let option: PhotoDestinationOption
    let row: EntityRow
    var id: String { "\(option.id):\(row.id)" }
}

private extension PhotoSelectionItem {
    var provenanceSource: PhotoAnalysisProvenance.Source {
        switch source {
        case .library: .photoLibrary
        case .file: .files
        }
    }

    var localIdentifier: String? {
        if case .library = source { return id }
        return nil
    }
}

private struct PhotoEntityChooser: View {
    @Environment(AppModel.self) private var appModel
    let key: EntityKey
    let captureDates: [Date?]
    let onSelect: (EntityRow) -> Void
    @State private var model: PhotoEntityChooserModel?

    private var descriptor: EntityDescriptor { EntityCatalog[key] }

    var body: some View {
        Group {
            if let model {
                if model.isSearching {
                    searchContent(model)
                } else if !model.dateMatches.isEmpty || !model.recentRows.isEmpty {
                    destinationList(model)
                } else {
                    emptyState(model)
                }
            } else {
                LoadingIndicator.screen(label: "Loading \(descriptor.plural)")
            }
        }
        .navigationTitle(descriptor.plural)
        .modifier(
            PhotoEntitySearchModifier(
                enabled: descriptor.primarySearch != nil,
                text: Binding(
                    get: { model?.search?.query ?? "" },
                    set: { model?.setSearchQuery($0) }
                ),
                prompt: descriptor.primarySearch?.placeholder
                    ?? "Search \(descriptor.plural.lowercased()) or shortcode"
            )
        )
        .task(id: key) {
            if model == nil {
                model = PhotoEntityChooserModel(
                    descriptor: descriptor, captureDates: captureDates,
                    loader: { filters, query, page, sort in
                        var requestFilters = filters
                        if let query, !query.isEmpty {
                            requestFilters.set(.single(query), for: "searchQuery")
                        }
                        return try await appModel.client.list(
                            descriptor, page: page, pageSize: 25, sort: sort, filters: requestFilters)
                    })
            }
            await model?.loadInitial()
        }
        .refreshControl { await model?.refresh() }
    }

    @ViewBuilder
    private func emptyState(_ model: PhotoEntityChooserModel) -> some View {
        if model.isLoading {
            LoadingIndicator.screen(label: "Loading \(descriptor.plural)")
        } else if let message = model.dateError ?? model.recentError {
            ContentUnavailableView {
                Label("Couldn't load \(descriptor.plural)", systemImage: "exclamationmark.triangle")
            } description: {
                Text(message)
            } actions: {
                Button("Retry") { Task { await model.refresh() } }
                    .accessibilityIdentifier("photos.destination.retry")
            }
        } else {
            ContentUnavailableView("No \(descriptor.plural) yet", systemImage: entitySymbol(for: key))
        }
    }

    private func destinationList(_ model: PhotoEntityChooserModel) -> some View {
        List {
            if model.hasDateMatches {
                Section {
                    if let error = model.dateError {
                        Text(error).foregroundStyle(.secondary)
                        Button("Retry date matches") { Task { await model.refresh() } }
                    }
                    ForEach(model.dateMatches) { row in destinationRow(row, model: model) }
                    if model.hasMoreDateMatches {
                        Button {
                            Task { await model.loadMoreDateMatches() }
                        } label: {
                            if model.isLoadingDateNextPage {
                                LoadingIndicator(label: "Loading more matches")
                            } else {
                                Text("Load more matches")
                            }
                        }
                        .disabled(model.isLoadingDateNextPage)
                    }
                } header: {
                    Text(
                        "Matches \(model.captureDate?.formatted(date: .abbreviated, time: .omitted) ?? "photo date")"
                    )
                }
            }
            Section {
                if let error = model.recentError {
                    Text(error).foregroundStyle(.secondary)
                    Button("Retry recent records") { Task { await model.refresh() } }
                }
                ForEach(model.recentRows) { row in destinationRow(row, model: model) }
                if model.hasMoreRecents {
                    Button {
                        Task { await model.loadMoreRecents() }
                    } label: {
                        if model.isLoadingRecentNextPage {
                            LoadingIndicator(label: "Loading more recent records")
                        } else {
                            Text("Load more recent records")
                        }
                    }
                    .disabled(model.isLoadingRecentNextPage)
                }
            } header: {
                Text("Recently edited")
            }
        }
    }

    @ViewBuilder
    private func searchContent(_ model: PhotoEntityChooserModel) -> some View {
        if let search = model.search {
            if search.rows.isEmpty {
                switch search.phase {
                case .idle, .debouncing, .loading:
                    LoadingIndicator.screen(label: "Searching \(descriptor.plural)")
                case .failed(let message):
                    ContentUnavailableView {
                        Label("Couldn't search \(descriptor.plural)", systemImage: "exclamationmark.triangle")
                    } description: {
                        Text(message)
                    } actions: {
                        Button("Retry") { search.retry() }
                    }
                case .loaded:
                    ContentUnavailableView("No matching \(descriptor.plural)", systemImage: "magnifyingglass")
                }
            } else {
                List {
                    ForEach(search.rows) { row in destinationRow(row, model: model) }
                    if search.hasMore {
                        Button {
                            Task { await search.loadNextPage() }
                        } label: {
                            if search.phase == .loading {
                                LoadingIndicator(label: "Loading more \(descriptor.plural)")
                            } else {
                                Text("Load more")
                            }
                        }
                        .disabled(search.phase != .loaded)
                    }
                }
            }
        } else {
            ContentUnavailableView("Search unavailable", systemImage: "magnifyingglass")
        }
    }

    @ViewBuilder
    private func destinationRow(_ row: EntityRow, model: PhotoEntityChooserModel) -> some View {
        Button {
            onSelect(row)
        } label: {
            EntityRowView(key: key, row: row, photoMode: true)
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("photos.destination.row.\(row.id)")
    }
}

/// Stages a manifest-declared related record without calling the ordinary entity create endpoint.
/// The generic field controls still own validation and reference picking; the resulting body is
/// handed back to the import transaction so the record and its photos commit together.
private struct PhotoRelatedCreateEditor: View {
    let option: PhotoDestinationOption
    let source: EntityRow
    let captureDate: Date?
    let onDraft: ([String: JSONValue]) -> Void

    @Environment(AppModel.self) private var appModel
    @Environment(\.dismiss) private var dismiss
    @State private var model: GenericEntityEditModel?
    @State private var pickedTitles: [String: String] = [:]

    private var descriptor: EntityDescriptor { option.descriptor }

    var body: some View {
        NavigationStack {
            Group {
                if let model {
                    Form {
                        Section {
                            Label(
                                "This record and its photos will be added together",
                                systemImage: "checkmark.shield"
                            )
                            .foregroundStyle(.secondary)
                        }
                        ForEach(model.sections) { section in
                            let fields = section.fields.compactMap(descriptor.field).filter(renders)
                            if !fields.isEmpty {
                                Section(section.title) {
                                    ForEach(fields, id: \.key) { field in
                                        EntityFieldControl(
                                            field: field, model: model, pickedTitles: $pickedTitles)
                                    }
                                }
                            }
                        }
                    }
                    .formStyle(.grouped)
                } else {
                    LoadingIndicator.screen(label: "Preparing \(descriptor.singular)")
                }
            }
            .navigationTitle("New \(descriptor.singular)")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Stage") {
                        guard let model, model.canSave else { return }
                        onDraft(model.createBody())
                        dismiss()
                    }
                    .disabled(!(model?.canSave ?? false))
                    .accessibilityIdentifier("photos.destination.create.stage")
                }
            }
        }
        .nativeSheet(.editor)
        .task {
            guard model == nil else { return }
            let created = GenericEntityEditModel(
                descriptor: descriptor,
                mode: .create(prefill: createPrefill()),
                client: appModel.client)
            model = created
        }
    }

    private func renders(_ field: FieldDescriptor) -> Bool {
        if ["pendingImageIds", "removeImageIds", "imageOrder"].contains(field.key) { return false }
        if option.route.bindings.contains(where: {
            $0.field == field.key && !($0.source == "capture-date" && captureDate == nil)
        }) {
            return false
        }
        guard field.controlKind == .specialized else { return true }
        return field.reference != nil || field.format == "amount" || field.kind == .textArray
    }

    private func createPrefill() -> [String: JSONValue] {
        var result: [String: JSONValue] = [:]
        for binding in option.route.bindings {
            switch binding.source {
            case "source-id":
                if binding.itemField != nil {
                    result[binding.field] = .array([.string(source.id)])
                } else {
                    result[binding.field] = .string(source.id)
                }
            case "source-field":
                if let sourceField = binding.sourceField, let value = source.raw[sourceField] {
                    result[binding.field] = value
                }
            case "capture-date":
                if let captureDate {
                    result[binding.field] = .string(PlainDate(captureDate).rawValue)
                }
            case "constant":
                if let json = binding.constantJSON,
                    let data = json.data(using: .utf8),
                    let value = try? JSONDecoder().decode(JSONValue.self, from: data)
                {
                    result[binding.field] = value
                }
            case "relation-items":
                if let itemField = binding.itemField {
                    result[binding.field] = .array([.object([itemField: .string(source.id)])])
                }
            default:
                break
            }
        }
        return result
    }
}

/// Resolves an existing destination through the route's manifest-owned relationship path.
/// The server revalidates this relationship inside the commit transaction; this view only
/// presents the bounded graph page so invalid arbitrary destinations are never offered.
private struct PhotoRelatedDestinationChooser: View {
    @Environment(AppModel.self) private var appModel
    let context: PhotoRelatedContext
    let onSelect: (EntityRow) -> Void

    @State private var rows: [EntityRow] = []
    @State private var nextOffset: Int?
    @State private var isLoading = true
    @State private var errorMessage: String?
    @State private var search = ""

    private var descriptor: EntityDescriptor { context.option.descriptor }

    private var filteredRows: [EntityRow] {
        guard !search.isEmpty else { return rows }
        return rows.filter {
            $0.title.localizedCaseInsensitiveContains(search)
                || $0.id.localizedCaseInsensitiveContains(search)
        }
    }

    var body: some View {
        NavigationStack {
            Group {
                if isLoading, rows.isEmpty {
                    LoadingIndicator.screen(label: "Loading related \(descriptor.plural)")
                } else if let errorMessage, rows.isEmpty {
                    ContentUnavailableView {
                        Label("Couldn't load \(descriptor.plural)", systemImage: "exclamationmark.triangle")
                    } description: {
                        Text(errorMessage)
                    } actions: {
                        Button("Retry") { Task { await load(reset: true) } }
                    }
                } else if rows.isEmpty {
                    ContentUnavailableView(
                        "No related \(descriptor.plural)",
                        systemImage: entitySymbol(for: context.option.route.target),
                        description: Text("\(context.source.title) has no matching destination yet."))
                } else {
                    List {
                        ForEach(filteredRows) { row in
                            Button {
                                onSelect(row)
                            } label: {
                                EntityRowView(
                                    key: context.option.route.target, row: row, photoMode: true)
                            }
                            .buttonStyle(.plain)
                            .accessibilityIdentifier("photos.destination.related.\(row.id)")
                        }
                        if nextOffset != nil, search.isEmpty {
                            Button {
                                Task { await load(reset: false) }
                            } label: {
                                if isLoading {
                                    LoadingIndicator(label: "Loading more \(descriptor.plural)")
                                } else {
                                    Text("Load more")
                                }
                            }
                            .disabled(isLoading)
                        }
                    }
                }
            }
            .navigationTitle("Related \(descriptor.plural)")
            .searchable(text: $search, prompt: "Search name or shortcode")
        }
        .nativeSheet(.editor)
        .task { await load(reset: true) }
    }

    private func load(reset: Bool) async {
        guard let relationshipKey = context.option.route.relationPath.first,
            context.option.route.relationPath.count == 1
        else {
            errorMessage = "This relationship path is not supported by this version of Cubby."
            isLoading = false
            return
        }
        if reset {
            rows = []
            nextOffset = nil
        }
        guard !isLoading || reset else { return }
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        do {
            let root = EntityRef(entity: context.option.route.source, id: context.source.id)
            let page = try await appModel.client.relationshipPage(
                root: root,
                relationshipKey: relationshipKey,
                offset: reset ? 0 : (nextOffset ?? 0),
                limit: 25)
            let branch = page.branches.first {
                $0.root == root && $0.relationshipKey == relationshipKey
            }
            let nodes = Dictionary(
                page.nodes.map { ($0.reference, $0) }, uniquingKeysWith: { _, newer in newer })
            let loaded = (branch?.items ?? []).compactMap { reference -> EntityRow? in
                guard reference.entity == context.option.route.target,
                    let node = nodes[reference]
                else { return nil }
                return EntityRow(
                    id: reference.id,
                    title: node.label,
                    subtitle: nil,
                    imageURL: node.imageURL,
                    raw: .object(["id": .string(reference.id), "name": .string(node.label)]))
            }
            rows = Dictionary(
                grouping: rows + loaded, by: \.id
            ).values.compactMap(\.last).sorted { $0.title < $1.title }
            nextOffset = branch?.nextOffset
        } catch is CancellationError {
            return
        } catch {
            errorMessage = error.localizedDescription
            Diagnostics.report(error, context: "photos.destination.related.\(context.option.id)")
        }
    }
}

private struct PhotoEntitySearchModifier: ViewModifier {
    let enabled: Bool
    @Binding var text: String
    let prompt: String

    @ViewBuilder
    func body(content: Content) -> some View {
        if enabled {
            content.searchable(text: $text, prompt: prompt)
        } else {
            content
        }
    }
}

#Preview(traits: .modifier(SignedInPreview())) {
    PhotoDestinationSheet(items: [], onDone: { _ in })
}
