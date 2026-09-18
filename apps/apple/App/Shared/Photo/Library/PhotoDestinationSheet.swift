import CubbyKit
import Observation
import SwiftUI

/// One review surface for routing, staging, and atomically committing a selected photo batch.
struct PhotoDestinationSheet: View {
    @Environment(AppModel.self) private var appModel
    @Environment(\.dismiss) private var dismiss
    let onDone: ([String]) -> Void
    @State private var manifest: PhotoImportManifest
    @State private var path: [PhotoImportNavigationDestination] = []
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
                analysisStatus
                destinationAction
                List {
                    if !manifest.needsDestination.isEmpty {
                        Section("Needs a destination") {
                            PhotoImportGroupRows(
                                ids: manifest.needsDestination, manifest: manifest)
                        }
                    }
                    ForEach(manifest.groups) { group in
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
                PhotoAnalysisDisclosure(manifest: manifest)
            }
            .safeAreaInset(edge: .bottom, spacing: 0) { footer }
            .navigationTitle("Review photos")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .automatic) {
                    if manifest.canUndo {
                        Button("Undo", systemImage: "arrow.uturn.backward") {
                            manifest.undoLastMove()
                        }
                        .keyboardShortcut("z", modifiers: .command)
                        .accessibilityIdentifier("photos.manifest.undo")
                    }
                }
            }
            .navigationDestination(for: PhotoImportNavigationDestination.self) { destination in
                switch destination {
                case .sourceTypes:
                    List {
                        PhotoImportHero(items: manifest.items, selectedIDs: manifest.selectedIDs)
                        PhotoAnalysisDisclosure(manifest: manifest)
                        Section("Choose what is in the photo") {
                            ForEach(manifest.sourceTypeOptions) { type in
                                Button {
                                    path.append(.sourceType(type.source))
                                } label: {
                                    HStack(spacing: 12) {
                                        Image(systemName: entitySymbol(for: type.source))
                                            .frame(width: 24)
                                        VStack(alignment: .leading, spacing: 2) {
                                            Text(type.title)
                                            Text(type.outcomeDescription)
                                                .font(.caption)
                                                .foregroundStyle(.secondary)
                                        }
                                    }
                                }
                                .accessibilityIdentifier("photos.source-type.\(type.source.rawValue)")
                            }
                        }
                    }
                    .navigationTitle("Assign selected…")
                case .sourceType(let source):
                    if let type = manifest.sourceTypeOptions.first(where: {
                        $0.source == source
                    }) {
                        PhotoEntityChooser(
                            key: source, captureDates: manifest.selectedItems.map(\.capturedAt),
                            heroItems: manifest.items, importManifest: manifest
                        ) { row in
                            chooseSourceRecord(type, row: row)
                        }
                    } else {
                        ContentUnavailableView(
                            "Destination unavailable",
                            systemImage: "exclamationmark.triangle",
                            description: Text(
                                "Cubby couldn't resolve the photo routes for this type."
                            ))
                    }
                case .routePicker(let source, let row):
                    List {
                        PhotoImportHero(items: manifest.items, selectedIDs: manifest.selectedIDs)
                        PhotoAnalysisDisclosure(manifest: manifest)
                        if let type = manifest.sourceTypeOptions.first(where: {
                            $0.source == source
                        }) {
                            Section(
                                "Where should this \(EntityCatalog[source].singular) store photos?"
                            ) {
                                ForEach(type.options) { option in
                                    Button(option.menuTitle(for: row)) {
                                        chooseRoute(option, source: row)
                                    }
                                    .accessibilityIdentifier("photos.route.\(option.id)")
                                }
                            }
                        } else {
                            ContentUnavailableView(
                                "Destination unavailable",
                                systemImage: "exclamationmark.triangle",
                                description: Text(
                                    "Cubby couldn't resolve the photo routes for \(row.id)."
                                ))
                        }
                    }
                    .navigationTitle("Choose storage")
                }
            }
        }
        .nativeSheet(.photo)
        .interactiveDismissDisabled(manifest.isCommitting)
        .task {
            manifest.startAnalysis(client: appModel.client, matches: appModel.photoMatches)
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
                captureDate: manifest.selectedItems.compactMap(\.capturedAt).min(),
                heroItems: manifest.items,
                importManifest: manifest
            ) { body in
                manifest.stageCreate(
                    option: context.option, source: context.source, body: body)
                createContext = nil
                path.removeAll()
            }
        }
        .sheet(item: $relatedContext) { context in
            PhotoRelatedDestinationChooser(
                context: context,
                createOption: manifest.createAlternative(for: context.option),
                captureDate: manifest.selectedItems.compactMap(\.capturedAt).min(),
                heroItems: manifest.items,
                importManifest: manifest
            ) { row in
                manifest.moveSelected(to: context.option, source: context.source, destination: row)
                relatedContext = nil
                if !path.isEmpty { path.removeLast() }
            } onCreate: { option, body in
                manifest.stageCreate(option: option, source: context.source, body: body)
                if !path.isEmpty { path.removeLast() }
            }
            .environment(appModel)
        }
    }

    @ViewBuilder
    private var analysisStatus: some View {
        switch manifest.analysisState {
        case .idle:
            EmptyView()
        case .running(let message):
            HStack(spacing: 10) {
                ProgressView().controlSize(.small).accessibilityHidden(true)
                Text(message)
                Spacer()
                Button("Stop") { manifest.cancelAnalysis() }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .accessibilityIdentifier("photos.analysis.cancel")
            }
            .font(.subheadline)
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.bar)
            .accessibilityElement(children: .combine)
        case .complete:
            Label(
                manifest.needsDestination.isEmpty
                    ? "Analysis complete"
                    : "Analysis complete · \(manifest.needsDestination.count) need a destination",
                systemImage: "checkmark.circle"
            )
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
        case .failed(let message):
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Label(message, systemImage: "exclamationmark.triangle")
                    .foregroundStyle(PorcelainTokens.destructive)
                Spacer()
                Button("Retry") {
                    Task {
                        manifest.startAnalysis(
                            client: appModel.client, matches: appModel.photoMatches)
                    }
                }
            }
            .font(.subheadline)
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
        }
    }

    @ViewBuilder
    private var destinationAction: some View {
        if !manifest.selectedIDs.isEmpty {
            VStack(spacing: 6) {
                if let suggested = manifest.selectedSuggestedSource {
                    Button {
                        chooseSourceRecord(suggested.type, row: suggested.row)
                    } label: {
                        Label(
                            "Choose \(suggested.row.title) · \(suggested.row.id)",
                            systemImage: entitySymbol(for: suggested.type.source)
                        )
                        .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .accessibilityIdentifier("photos.manifest.suggested-source")

                    Button("Choose another type…") { path.append(.sourceTypes) }
                        .buttonStyle(.plain)
                        .foregroundStyle(.secondary)
                } else if let suggested = manifest.selectedSuggestedSourceType {
                    Button {
                        path.append(.sourceType(suggested))
                    } label: {
                        Label(
                            "Choose \(EntityCatalog[suggested].singular.lowercased())",
                            systemImage: entitySymbol(for: suggested)
                        )
                        .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .accessibilityIdentifier("photos.manifest.suggested-source-type")

                    Button("Choose another type…") { path.append(.sourceTypes) }
                        .buttonStyle(.plain)
                        .foregroundStyle(.secondary)
                } else if !manifest.selectedSourceTypeSuggestionGroups.isEmpty {
                    ForEach(manifest.selectedSourceTypeSuggestionGroups) { group in
                        Button {
                            manifest.selectSuggestedPhotos(for: group.source)
                            path.append(.sourceType(group.source))
                        } label: {
                            Label(
                                "Choose \(EntityCatalog[group.source].plural) for \(group.photoIDs.count) photos",
                                systemImage: entitySymbol(for: group.source)
                            )
                            .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.borderedProminent)
                        .accessibilityIdentifier(
                            "photos.manifest.suggested-group.\(group.source.rawValue)")
                    }

                    Button("Choose another type…") { path.append(.sourceTypes) }
                        .buttonStyle(.plain)
                        .foregroundStyle(.secondary)
                } else {
                    Button {
                        path.append(.sourceTypes)
                    } label: {
                        Label("Assign selected…", systemImage: "arrow.right.circle")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                }
            }
            .controlSize(.large)
            .padding(.horizontal, 16)
            .padding(.bottom, 10)
            .accessibilityIdentifier("photos.manifest.destination")
        }
    }

    private func chooseSourceRecord(_ type: PhotoSourceTypeOption, row: EntityRow) {
        // A natural record can have several concrete destinations (Planting → an existing
        // Garden Entry or a new one). Always expose that route choice after the source is known;
        // otherwise a primary create route would silently create a related record.
        if let destination = PhotoImportNavigationDestination.sourceSelection(type: type, row: row) {
            path.append(destination)
        } else if let only = type.options.first {
            chooseRoute(only, source: row)
        }
    }

    private func chooseRoute(_ option: PhotoDestinationOption, source: EntityRow) {
        switch option.route.kind {
        case .createRelated:
            createContext = PhotoCreateContext(option: option, source: source)
        case .existingRelated:
            relatedContext = PhotoRelatedContext(option: option, source: source)
            path.removeAll()
        case .`self`:
            manifest.moveSelected(to: option, row: source)
            path.removeAll()
        }
    }

    private var selectedStrip: some View {
        PhotoImportHero(
            items: manifest.items,
            selectedIDs: manifest.selectedIDs,
            onToggle: manifest.toggle
        )
    }

    private var footer: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let error = manifest.errorMessage {
                Label(error, systemImage: "exclamationmark.triangle")
                    .font(.caption)
                    .foregroundStyle(PorcelainTokens.destructive)
            }
            if !manifest.canCommit, let reason = manifest.commitDisabledReason {
                Label(reason, systemImage: "info.circle")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            HStack {
                Text("\(manifest.items.count) photo\(manifest.items.count == 1 ? "" : "s")")
                Spacer()
                if manifest.commitRequiresReview {
                    Button("Check status") {
                        Task {
                            guard
                                let committedIDs = await manifest.checkCommitStatus(
                                    client: appModel.client)
                            else { return }
                            await finish(with: committedIDs)
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                    .accessibilityIdentifier("photos.destination.checkStatus")
                } else {
                    Button(manifest.commitActionTitle) {
                        Task {
                            guard let committedIDs = await manifest.commit(client: appModel.client)
                            else { return }
                            await finish(with: committedIDs)
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                    .disabled(!manifest.canCommit)
                    .accessibilityIdentifier("photos.manifest.add")
                }
            }
        }.padding(16).background(.bar)
    }

    private func finish(with committedIDs: [String]) async {
        onDone(committedIDs)
        dismiss()
        await appModel.photoMatches.refresh(client: appModel.client, priorityIDs: Set(committedIDs))
    }
}

@MainActor
@Observable
final class PhotoImportManifest {
    let items: [PhotoSelectionItem]
    var selectedIDs: Set<String>
    private var assignments: [String: PhotoDestinationAssignment] = [:]
    private(set) var isCommitting = false
    private(set) var analysisState: PhotoImportAnalysisState = .idle
    private(set) var progress = "Preparing…"
    private(set) var errorMessage: String?
    private(set) var hasCommitted = false
    private(set) var suggestions: [String: String] = [:]
    private(set) var suggestedSourceTypes: [String: EntityKey] = [:]
    private(set) var suggestedSourceRecords: [String: EntityRow] = [:]
    private(set) var foundationModelSummary: String?
    private(set) var analysisLog: [PhotoAnalysisLogEntry] = []
    private(set) var commitRequiresReview = false
    private(set) var duplicateCandidates: [String: [DedupCandidate]] = [:]
    private(set) var duplicateOwnerShortcodes: [String: [String]] = [:]
    private var duplicateDecisions: [String: PhotoDuplicateDecision] = [:]
    private var analysisGeneration = UUID()
    private var undoSnapshot: [PhotoUndoAssignment] = []
    private var prepared: [String: (PhotoFile, PhotoLocalAnalysis)] = [:]
    private var transaction: PhotoImportTransaction?
    private var analysisTask: Task<Void, Never>?
    private var nextAnalysisLogID = 0

    init(items: [PhotoSelectionItem]) {
        self.items = items
        selectedIDs = Set(items.map(\.id))
    }

    func startAnalysis(client: CubbyClient, matches: PhotoMatchStore) {
        analysisTask?.cancel()
        analysisTask = Task { [weak self] in
            await self?.analyze(client: client, matches: matches)
        }
    }

    func cancelAnalysis() {
        analysisTask?.cancel()
        analysisTask = nil
        analysisGeneration = UUID()
        if analysisState.isRunning { analysisState = .idle }
    }

    var destinationOptions: [PhotoDestinationOption] {
        PhotoImportCatalog.ingressRoutes
            .filter { $0.storage != nil }
            .map { PhotoDestinationOption(route: $0, descriptor: EntityCatalog[$0.target]) }
            .sorted { $0.menuTitle < $1.menuTitle }
    }

    /// Natural source types are unique even when one type has several storage routes.
    /// The catalog is generated from the manifest; callers must not build an entity roster here.
    var sourceTypeOptions: [PhotoSourceTypeOption] {
        let routes = destinationOptions.reduce(into: [EntityKey: [PhotoDestinationOption]]()) {
            $0[$1.route.source, default: []].append($1)
        }
        return routes.keys.sorted { EntityCatalog[$0].plural < EntityCatalog[$1].plural }.compactMap {
            guard let options = routes[$0] else { return nil }
            return PhotoSourceTypeOption(
                source: $0, options: options.sorted { $0.menuTitle < $1.menuTitle })
        }
    }

    var selectedItems: [PhotoSelectionItem] {
        items.filter { selectedIDs.contains($0.id) }
    }

    var needsDestination: [String] {
        items.map(\.id).filter { assignments[$0] == nil }
    }

    var selectedSuggestedSourceType: EntityKey? {
        Self.preferredSourceType(selectedIDs: selectedIDs, suggestions: suggestedSourceTypes)
    }

    var selectedSourceTypeSuggestionGroups: [PhotoSourceTypeSuggestionGroup] {
        Self.sourceTypeSuggestionGroups(
            selectedIDs: selectedIDs, suggestions: suggestedSourceTypes)
    }

    var selectedSuggestedSource: PhotoSuggestedSource? {
        guard let source = selectedSuggestedSourceType else { return nil }
        let rows = selectedIDs.compactMap { suggestedSourceRecords[$0] }
        guard let first = rows.first, rows.count == selectedIDs.count,
            Set(rows.map(\.id)).count == 1,
            let type = sourceTypeOptions.first(where: { $0.source == source })
        else { return nil }
        return PhotoSuggestedSource(type: type, row: first)
    }

    static func preferredSourceType(
        selectedIDs: Set<String>, suggestions: [String: EntityKey]
    ) -> EntityKey? {
        let values = Set(selectedIDs.compactMap { suggestions[$0] })
        return values.count == 1 && selectedIDs.allSatisfy { suggestions[$0] != nil }
            ? values.first : nil
    }

    static func sourceTypeSuggestionGroups(
        selectedIDs: Set<String>, suggestions: [String: EntityKey]
    ) -> [PhotoSourceTypeSuggestionGroup] {
        Dictionary(
            grouping: selectedIDs.compactMap { photoID in
                suggestions[photoID].map { (photoID, $0) }
            }, by: { $0.1 }
        ).map { source, values in
            PhotoSourceTypeSuggestionGroup(
                source: source, photoIDs: values.map(\.0).sorted())
        }.sorted { lhs, rhs in
            if lhs.photoIDs.count != rhs.photoIDs.count {
                return lhs.photoIDs.count > rhs.photoIDs.count
            }
            return EntityCatalog[lhs.source].plural < EntityCatalog[rhs.source].plural
        }
    }

    func selectSuggestedPhotos(for source: EntityKey) {
        selectedIDs = Set(
            selectedIDs.filter { suggestedSourceTypes[$0] == source })
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
        !items.isEmpty && needsDestination.isEmpty && unresolvedDuplicateIDs.isEmpty
            && !isCommitting && !hasCommitted && !commitRequiresReview
    }

    var commitActionTitle: String {
        if hasCommitted { return "Added" }
        return isCommitting ? progress : commitButtonTitle
    }

    var commitButtonTitle: String {
        let photoCount = items.count
        let photos = "\(photoCount) photo\(photoCount == 1 ? "" : "s")"
        let drafts = Dictionary(
            grouping: assignments.values.compactMap(\.createDraft), by: \.id
        ).values.compactMap(\.first)
        guard !drafts.isEmpty else { return "Add \(photos)" }
        if drafts.count == 1, let draft = drafts.first {
            return "Add \(photos) + \(EntityCatalog[draft.route.target].singular)"
        }
        return "Add \(photos) + \(drafts.count) records"
    }

    var commitDisabledReason: String? {
        if items.isEmpty { return "Select at least one photo." }
        if !needsDestination.isEmpty {
            return
                "Assign a destination to \(needsDestination.count) photo\(needsDestination.count == 1 ? "" : "s")."
        }
        if !unresolvedDuplicateIDs.isEmpty {
            return "Review the duplicate match decision before adding photos."
        }
        if commitRequiresReview {
            return
                "This commit's outcome could not be confirmed. Check status once you're back online before trying again."
        }
        if isCommitting { return progress }
        return nil
    }

    var unresolvedDuplicateIDs: [String] {
        duplicateCandidates.keys.filter { duplicateDecisions[$0] == nil }.sorted()
    }

    var canUndo: Bool { !undoSnapshot.isEmpty }

    func createAlternative(for option: PhotoDestinationOption) -> PhotoDestinationOption? {
        guard option.route.kind == .existingRelated else { return nil }
        return destinationOptions.first {
            $0.route.kind == .createRelated
                && $0.route.source == option.route.source
                && $0.route.target == option.route.target
                && $0.route.relationPath == option.route.relationPath
        }
    }

    func analyze(client: CubbyClient, matches: PhotoMatchStore) async {
        guard !analysisState.isRunning else { return }
        let generation = UUID()
        analysisGeneration = generation
        analysisLog = []
        nextAnalysisLogID = 0
        appendAnalysisLog(
            "Started on-device analysis",
            detail: "\(items.count) photo\(items.count == 1 ? "" : "s")",
            kind: .progress)
        analysisState = .running("Preparing selected photos…")
        do {
            try await prepareIfNeeded()
            for item in items {
                guard let analysis = prepared[item.id]?.1 else { continue }
                appendAnalysisLog(
                    "Vision finished for \(photoLabel(item.id))",
                    detail: analysisLogSummary(analysis), photoID: item.id, kind: .progress)
                if let suggestion = suggestedSource(for: analysis) {
                    suggestedSourceTypes[item.id] = suggestion.source
                    suggestions[item.id] = suggestion.label
                    appendAnalysisLog(
                        "Type suggestion: \(EntityCatalog[suggestion.source].plural)",
                        detail: suggestion.label, photoID: item.id, kind: .decision)
                } else {
                    appendAnalysisLog(
                        "No confident type suggestion",
                        detail: "Manual assignment remains available.", photoID: item.id,
                        kind: .abstention)
                }
            }
            analysisState = .running("Checking for duplicates…")
            do {
                try await matches.check(
                    items,
                    client: client,
                    preparedQueries: preparedHashQueries,
                    refreshIndex: false
                ) { [weak self] status in
                    self?.analysisState = .running(status)
                }
                for item in items {
                    let candidates = Self.uniqueCandidates(matches.storedCandidates(for: item.id))
                    if !candidates.isEmpty {
                        duplicateCandidates[item.id] = candidates
                        for candidate in candidates {
                            duplicateOwnerShortcodes[candidate.id.rawValue] =
                                matches.directOwnerShortcodes(for: candidate.id)
                        }
                        let duplicateDescription =
                            "\(candidates.count) existing image match"
                            + (candidates.count == 1 ? "" : "es")
                        appendAnalysisLog(
                            "Possible duplicate for \(photoLabel(item.id))",
                            detail: duplicateDescription,
                            photoID: item.id, kind: .decision)
                    }
                }
            } catch is CancellationError {
                throw CancellationError()
            } catch {
                Diagnostics.report(error, context: "photos.manifest.identity")
            }
            analysisState = .running("Finding possible destinations…")
            let candidates = await loadCandidates(client: client)
            guard analysisGeneration == generation, !Task.isCancelled else { throw CancellationError() }
            guard !candidates.isEmpty else {
                appendAnalysisLog(
                    "No record candidates loaded",
                    detail: "Vision results are preserved; choose a destination manually.",
                    kind: .abstention)
                analysisState = .complete
                return
            }
            let candidateCounts = Dictionary(grouping: candidates, by: { $0.option.route.source })
                .map { "\(EntityCatalog[$0.key].plural): \($0.value.count)" }
                .sorted()
                .joined(separator: " · ")
            appendAnalysisLog(
                "Loaded manifest-scoped candidates", detail: candidateCounts, kind: .progress)
            analysisState = .running("Comparing with existing photos…")
            let visualMatches = await PhotoVisualEvidenceMatcher().matches(
                analyses: prepared.mapValues(\.1),
                candidates: candidates.compactMap { candidate in
                    guard let source = candidate.routing.sourceEntity,
                        let sourceID = candidate.routing.sourceID
                    else { return nil }
                    return PhotoVisualEvidenceCandidate(
                        id: candidate.routing.id, source: source, sourceID: sourceID)
                },
                client: client)
            guard analysisGeneration == generation, !Task.isCancelled else {
                throw CancellationError()
            }
            let evidence = items.compactMap { item -> PhotoRoutingEvidence? in
                guard let analysis = prepared[item.id]?.1 else { return nil }
                let owners = matches.strongDirectOwnerShortcodes(for: item.id)
                let candidateIDs = deterministicCandidateIDs(
                    for: analysis, authoritativeOwners: Set(owners),
                    visualMatch: visualMatches[item.id], among: candidates)
                return PhotoRoutingEvidence(
                    photoID: item.id,
                    summary: evidenceSummary(
                        analysis, authoritativeOwners: owners,
                        visualMatch: visualMatches[item.id], candidates: candidates),
                    deterministicCandidateIDs: candidateIDs)
            }
            let byID = Dictionary(uniqueKeysWithValues: candidates.map { ($0.routing.id, $0) })
            let reranker = PhotoSemanticReranker()
            // Publish deterministic decisions before optional Foundation Models work begins.
            let deterministic = reranker.deterministic(
                evidence: evidence, candidates: candidates.map(\.routing))
            appendDecisionLog(
                deterministic.decisions, candidates: byID, stage: "Deterministic routing")
            apply(decisions: deterministic.decisions, candidates: byID, generation: generation)
            analysisState = .running("Refining suggestions on this device…")
            appendAnalysisLog(
                "Foundation Models refinement started",
                detail: "\(evidence.count) photos · \(candidates.count) allowed candidates",
                kind: .progress)
            let result = try await reranker.rerank(
                evidence: evidence, candidates: candidates.map(\.routing))
            guard analysisGeneration == generation, !Task.isCancelled else { throw CancellationError() }
            foundationModelSummary = Self.foundationModelSummary(result.modelStatus)
            appendAnalysisLog(
                foundationModelSummary ?? "Foundation Models refinement finished",
                detail: Self.foundationModelLogDetail(result.modelStatus),
                kind: result.modelStatus == .used ? .decision : .fallback)
            appendDecisionLog(
                result.decisions, candidates: byID, stage: "Final routing")
            apply(decisions: result.decisions, candidates: byID, generation: generation)
            analysisState = .complete
            appendAnalysisLog(
                "Analysis complete",
                detail: "\(suggestedSourceTypes.count) of \(items.count) photos received a type suggestion.",
                kind: .progress)
        } catch is CancellationError {
            if !Task.isCancelled, analysisGeneration == generation {
                analysisState = .idle
                appendAnalysisLog("Analysis stopped", kind: .fallback)
            }
            return
        } catch {
            if analysisGeneration != generation { return }
            analysisState = .failed(
                "Analysis couldn’t finish. Retry, or choose a destination manually.")
            appendAnalysisLog(
                "Analysis failed", detail: error.localizedDescription, kind: .error)
            Diagnostics.report(error, context: "photos.manifest.analysis")
        }
    }

    private func apply(
        decisions: [PhotoRoutingDecision], candidates: [String: Candidate], generation: UUID
    ) {
        guard analysisGeneration == generation else { return }
        for decision in decisions {
            guard assignments[decision.photoID] == nil,
                let candidateID = decision.candidateID,
                let candidate = candidates[candidateID],
                candidate.option.id == decision.routeID
            else { continue }
            if candidate.option.route.choice == .prompt { continue }
            suggestedSourceRecords[decision.photoID] = candidate.row
            // Related routes still need a relationship resolver and an explicit existing-versus-
            // create choice. Keep the natural source suggestion, but never create a destination
            // merely because a classifier or Foundation Models ranked its source record.
            guard candidate.option.route.kind == .`self` else {
                suggestions[decision.photoID] =
                    "\(candidate.row.title) · \(candidate.row.id) · \(decision.explanation)"
                continue
            }
            assignments[decision.photoID] = PhotoDestinationAssignment(
                route: candidate.option.route,
                source: EntityRef(entity: candidate.option.route.source, id: candidate.row.id),
                recordID: candidate.row.id,
                title: "\(candidate.row.title) · \(candidate.row.id)",
                shortcode: candidate.row.id,
                replaceConfirmed: false,
                evidence: decision.explanation)
            suggestions[decision.photoID] =
                "\(candidate.row.title) · \(candidate.row.id) · \(decision.explanation)"
            selectedIDs.remove(decision.photoID)
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
        option: PhotoDestinationOption, source: EntityRow, body: [String: JSONValue],
        photoIDs: Set<String>? = nil
    ) {
        rememberMove()
        let itemsToStage = items.filter { photoIDs?.contains($0.id) ?? selectedIDs.contains($0.id) }
        let grouped = Dictionary(grouping: itemsToStage) { item in
            item.capturedAt.map { PlainDate($0).rawValue } ?? "undated"
        }
        for (day, group) in grouped {
            var dayBody = body
            if let binding = option.route.bindings.first(where: { $0.source == .captureDate }) {
                if day == "undated" {
                    dayBody.removeValue(forKey: binding.field)
                } else {
                    dayBody[binding.field] = .string(day)
                }
            }
            let draft = PhotoCreateDraft(
                id: "photo-import-\(UUID().uuidString)", route: option.route,
                source: EntityRef(entity: option.route.source, id: source.id), body: dayBody,
                title: "\(source.title) · \(source.id)",
                captureDate: group.compactMap(\.capturedAt).first)
            let assignment = PhotoDestinationAssignment(
                route: option.route, source: draft.source, recordID: nil, title: draft.title,
                shortcode: "New", replaceConfirmed: false,
                evidence: "New \(option.descriptor.singular) · \(day == "undated" ? "date needed" : day)",
                createDraft: draft)
            for item in group { assignments[item.id] = assignment }
        }
        selectedIDs.subtract(itemsToStage.map(\.id))
    }

    /// A nullable source relationship is a missing binding, not an instruction to write null.
    /// Keeping this rule in one helper also lets the editor expose the field for repair.
    static func nonNullSourceFieldValue(
        binding: PhotoCreateBinding, source: EntityRow
    ) -> JSONValue? {
        guard binding.source == .sourceField,
            let sourceField = binding.sourceField,
            let value = source.raw[sourceField], value != .null
        else { return nil }
        return value
    }

    func undoLastMove() {
        guard !undoSnapshot.isEmpty else { return }
        let snapshot = undoSnapshot
        for item in snapshot { assignments[item.photoID] = item.assignment }
        selectedIDs = Set(snapshot.map(\.photoID))
        undoSnapshot = []
    }

    /// The wire batch for every selected item, from its resolved assignment and prepared
    /// (materialized + analyzed) file. Shared by `commit(client:)` and `checkCommitStatus(client:)`
    /// so both submit/reconcile the same items the same way.
    private func makeBatch() throws -> [PhotoImportBatchItem] {
        try items.map { item -> PhotoImportBatchItem in
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
    }

    func commit(client: CubbyClient) async -> [String]? {
        guard canCommit else { return nil }
        isCommitting = true
        errorMessage = nil
        commitRequiresReview = false
        progress = "Adding photos…"
        defer { isCommitting = false }
        do {
            try await prepareIfNeeded()
            let batch = try makeBatch()
            let transaction = transaction ?? PhotoImportTransaction(client: client)
            self.transaction = transaction
            let committedClientIDs = try await transaction.commit(batch) { [weak self] state in
                Task { @MainActor in self?.updateProgress(state) }
            }
            hasCommitted = true
            progress = "Added"
            return committedClientIDs
        } catch let failure as PhotoImportTransaction.Failure {
            switch failure {
            case .commitOutcomeUncertain, .commitInvariant:
                commitRequiresReview = true
                progress = "Review required"
            case .stagedImagesExpired:
                transaction = nil
                progress = "Stage again"
            case .commitNotApplied:
                progress = "Ready to retry"
            default:
                progress = "Try again"
            }
            errorMessage = failure.localizedDescription
            appendAnalysisLog(
                "Commit stopped",
                detail: Self.importErrorDebugDetail(failure),
                kind: .fallback)
            Diagnostics.report(failure, context: "photos.manifest.commit")
            return nil
        } catch {
            errorMessage = Self.importErrorMessage(error)
            progress = "Try again"
            appendAnalysisLog(
                "Commit failed",
                detail: Self.importErrorDebugDetail(error),
                kind: .fallback)
            Diagnostics.report(error, context: "photos.manifest.commit")
            return nil
        }
    }

    /// Re-checks a commit whose outcome could not be confirmed (`commitRequiresReview`), without
    /// resending the write — the only way out of that state besides discarding the manifest, since
    /// `commit(client:)` refuses to run while the flag is set (`canCommit`).
    func checkCommitStatus(client: CubbyClient) async -> [String]? {
        // `let activeTransaction` (rather than shadowing the `transaction` property) so
        // `.stagedImagesExpired` below can still clear the property itself.
        guard commitRequiresReview, let activeTransaction = transaction else { return nil }
        do {
            let committedIDs = try await activeTransaction.reconcile(try makeBatch())
            hasCommitted = true
            commitRequiresReview = false
            progress = "Added"
            return committedIDs
        } catch let failure as PhotoImportTransaction.Failure {
            switch failure {
            case .commitNotApplied:
                commitRequiresReview = false
                progress = "Ready to retry"
            case .stagedImagesExpired:
                transaction = nil
                commitRequiresReview = false
                progress = "Stage again"
            default:
                // `.commitOutcomeUncertain` (still offline/ambiguous) or `.commitInvariant`
                // (mixed state): keep `commitRequiresReview` set so "Check status" remains the
                // only way forward.
                break
            }
            errorMessage = failure.localizedDescription
            appendAnalysisLog(
                "Status check stopped",
                detail: Self.importErrorDebugDetail(failure),
                kind: .fallback)
            Diagnostics.report(failure, context: "photos.manifest.checkCommitStatus")
            return nil
        } catch {
            errorMessage = Self.importErrorMessage(error)
            appendAnalysisLog(
                "Status check failed",
                detail: Self.importErrorDebugDetail(error),
                kind: .fallback)
            Diagnostics.report(error, context: "photos.manifest.checkCommitStatus")
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
            }
        ) { [weak self] completed, total in
            Task { @MainActor in
                self?.analysisState = .running("Analyzing photo \(completed) of \(total) on device…")
            }
        }
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

    private static func importErrorMessage(_ error: any Error) -> String {
        if let apiError = error as? CubbyAPIError {
            let message = apiError.errorDescription ?? "Cubby could not complete this request."
            if let requestID = apiError.detail?.requestId {
                return "\(message) · Request \(requestID)"
            }
            return message
        }
        if let localized = error as? any LocalizedError,
            let description = localized.errorDescription,
            !description.isEmpty
        {
            return description
        }
        let description = String(describing: error)
        return description.isEmpty ? "Cubby could not complete this request." : description
    }

    private static func importErrorDebugDetail(_ error: any Error) -> String {
        let type = String(reflecting: Swift.type(of: error))
        let detail = String(reflecting: error)
        return detail.isEmpty ? type : "\(type) · \(detail)"
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

    private func suggestedSource(
        for analysis: PhotoLocalAnalysis
    ) -> (source: EntityKey, label: String)? {
        let optionsByKey = Dictionary(
            sourceTypeOptions.compactMap { type -> (EntityKey, PhotoDestinationOption)? in
                let option =
                    type.options.first(where: { $0.route.choice == .primary })
                    ?? type.options.sorted { $0.id < $1.id }.first
                return option.map { (type.source, $0) }
            }, uniquingKeysWith: { first, _ in first })
        let candidates = optionsByKey.compactMap { key, option -> (EntityKey, String, Double, String)? in
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
            return (key, EntityCatalog[key].plural, match.confidence, match.identifier)
        }
        guard let best = candidates.max(by: { $0.2 < $1.2 }) else { return nil }
        return (best.0, "Suggested: \(best.1) · \(best.3)")
    }

    private struct Candidate: Sendable {
        let option: PhotoDestinationOption
        let row: EntityRow
        let routing: PhotoRoutingCandidate
    }

    private struct CandidatePage: Sendable {
        let index: Int
        let option: PhotoDestinationOption
        let rows: [EntityRow]
        let failure: CandidateLoadFailure?
    }

    private struct CandidateLoadFailure: LocalizedError, Sendable {
        let message: String
        var errorDescription: String? { message }
    }

    private var preparedHashQueries: [String: HashQuery] {
        Dictionary(
            uniqueKeysWithValues: prepared.compactMap { id, value in
                let analysis = value.1
                guard let hash = analysis.perceptualHash else { return nil }
                let ratio =
                    Double(max(analysis.width, analysis.height))
                    / Double(max(1, min(analysis.width, analysis.height)))
                return (
                    id,
                    HashQuery(
                        perceptualHash: hash,
                        aspectRatio: ratio,
                        sourceFingerprint: analysis.sourceFingerprint)
                )
            })
    }

    private func loadCandidates(client: CubbyClient) async -> [Candidate] {
        // Catalogs are expensive and do not improve an abstention. Vision's fast classifier is
        // the scope for automatic matching; manual assignment later loads only the chosen type.
        let likelySources = Set(suggestedSourceTypes.values)
        let options = sourceTypeOptions.filter { likelySources.contains($0.source) }.compactMap { type in
            let routes = type.options
            return routes.first(where: { $0.route.choice == .primary })
                ?? routes.sorted { $0.id < $1.id }.first
        }
        let pages = await withTaskGroup(of: CandidatePage.self, returning: [CandidatePage].self) {
            group in
            var iterator = Array(options.enumerated()).makeIterator()

            func enqueue(_ entry: (offset: Int, element: PhotoDestinationOption)) {
                group.addTask {
                    do {
                        let page = try await client.list(
                            EntityCatalog[entry.element.route.source], page: 1, pageSize: 25)
                        return CandidatePage(
                            index: entry.offset, option: entry.element, rows: page.items,
                            failure: nil)
                    } catch {
                        return CandidatePage(
                            index: entry.offset, option: entry.element, rows: [],
                            failure: CandidateLoadFailure(message: error.localizedDescription))
                    }
                }
            }

            for _ in 0..<min(4, options.count) {
                if let entry = iterator.next() { enqueue(entry) }
            }
            var result: [CandidatePage] = []
            for await page in group {
                result.append(page)
                if let entry = iterator.next() { enqueue(entry) }
            }
            return result.sorted { $0.index < $1.index }
        }

        let candidates = pages.flatMap { page -> [Candidate] in
            if let failure = page.failure {
                Diagnostics.report(
                    failure, context: "photos.manifest.candidates.\(page.option.id)")
            }
            let policy = PhotoImportCatalog.routingPolicies[page.option.route.source]
            return page.rows.compactMap { row in
                guard Self.matchesLifecycle(row, policy: policy),
                    !(page.option.route.requiresReplaceConfirmation && row.imageURL != nil)
                else { return nil }
                let description =
                    ([row.title, row.id]
                    + (policy?.candidateFields.compactMap { row.raw[$0]?.stringValue } ?? []))
                    .joined(separator: " · ")
                // Route identity is distinct from the natural source record. A source can expose
                // existing and create-related routes, so a candidate key must not collide when
                // those routes are loaded together.
                let candidateID = "\(page.option.id):\(row.id)"
                return Candidate(
                    option: page.option,
                    row: row,
                    routing: PhotoRoutingCandidate(
                        id: candidateID, routeID: page.option.id, description: description,
                        sourceEntity: page.option.route.source, sourceID: row.id))
            }
        }
        return Array(candidates.prefix(FoundationModelsPhotoSemanticModel.maximumCandidates))
    }

    /// Ranks a manually chosen natural-source catalog with the same prepared evidence used for
    /// automatic suggestions. Visual evidence is deliberately delegated to the manifest catalog
    /// matcher; it only follows declared paths to directly owned gallery attachments.
    func rankRows(
        for source: EntityKey, rows: [EntityRow], client: CubbyClient
    ) async throws -> [EntityRow] {
        guard !rows.isEmpty, !prepared.isEmpty else { return rows }
        try Task.checkCancellation()
        let analyses = prepared.mapValues(\.1)
        let visualMatches = await PhotoVisualEvidenceMatcher().matches(
            analyses: analyses,
            candidates: rows.map {
                PhotoVisualEvidenceCandidate(
                    id: "\(source.rawValue):\($0.id)", source: source, sourceID: $0.id)
            },
            client: client)
        try Task.checkCancellation()
        let policy = PhotoImportCatalog.routingPolicies[source]
        let ranked = rows.enumerated().map { index, row -> (EntityRow, Double, Int) in
            let searchable =
                ([row.title]
                + (policy?.candidateFields.compactMap { row.raw[$0]?.stringValue } ?? []))
                .joined(separator: " ").lowercased()
            let textScore = analyses.values.reduce(0.0) { score, analysis in
                max(
                    score,
                    analysis.recognizedText.reduce(0.0) { textScore, text in
                        let recognized = text.text.trimmingCharacters(in: .whitespacesAndNewlines)
                            .lowercased()
                        guard recognized.count >= 3, searchable.contains(recognized) else {
                            return textScore
                        }
                        return max(textScore, 0.96 * text.confidence)
                    })
            }
            let classifierScore = analyses.values.reduce(0.0) { score, analysis in
                max(
                    score,
                    analysis.classifications.filter { classification in
                        policy?.classifierLabels.contains {
                            classification.identifier.lowercased().contains($0.lowercased())
                        } ?? false
                    }.map(\.confidence).max() ?? 0)
            }
            let dateScore = analyses.values.reduce(0.0) { score, analysis in
                guard let day = analysis.capturedAt.map({ PlainDate($0).rawValue }) else {
                    return score
                }
                let matches =
                    policy?.temporalFields.contains { field in
                        row.raw[field]?.stringValue?.hasPrefix(day) == true
                    } ?? false
                return max(score, matches ? 0.88 : 0)
            }
            let visualScore =
                visualMatches.values.contains {
                    $0.candidateID == "\(source.rawValue):\(row.id)"
                } ? 1.0 : 0
            let score = min(1, max(textScore, dateScore, visualScore) + classifierScore * 0.08)
            return (row, score, index)
        }
        return ranked.sorted { lhs, rhs in
            lhs.1 == rhs.1 ? lhs.2 < rhs.2 : lhs.1 > rhs.1
        }.map(\.0)
    }

    private func deterministicCandidateIDs(
        for analysis: PhotoLocalAnalysis,
        authoritativeOwners: Set<String>,
        visualMatch: PhotoVisualEvidenceMatch?,
        among candidates: [Candidate]
    ) -> [String] {
        let scored = candidates.compactMap { candidate -> (String, Double, Double)? in
            guard let policy = PhotoImportCatalog.routingPolicies[candidate.option.route.source]
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
            let identityScore =
                authoritativeOwners.contains(candidate.row.id)
                    || visualMatch?.candidateID == candidate.routing.id ? 1.0 : 0
            let evidenceScore = max(textScore, dateScore, identityScore)
            let score = min(1, evidenceScore + classifierScore * 0.08)
            return (candidate.routing.id, score, policy.minimumScore)
        }.sorted { $0.1 > $1.1 }
        guard let first = scored.first, first.1 >= first.2 else { return [] }
        let policy = candidates.first(where: { $0.routing.id == first.0 }).flatMap {
            PhotoImportCatalog.routingPolicies[$0.option.route.source]
        }
        let runnerUp = scored.dropFirst().first?.1 ?? 0
        guard first.1 - runnerUp >= (policy?.minimumMargin ?? 1) else { return [] }
        return scored.prefix(5).filter { $0.1 >= $0.2 }.map(\.0)
    }

    private func evidenceSummary(
        _ analysis: PhotoLocalAnalysis, authoritativeOwners: [String],
        visualMatch: PhotoVisualEvidenceMatch?, candidates: [Candidate]
    ) -> String {
        let classifications = analysis.classifications.prefix(4).map(\.identifier).joined(separator: ", ")
        let text = analysis.recognizedText.prefix(4).map(\.text).joined(separator: " ")
        let date = analysis.capturedAt?.formatted(date: .abbreviated, time: .omitted) ?? "unknown date"
        let identity =
            authoritativeOwners.isEmpty
            ? "" : " Matched authoritative image: \(authoritativeOwners.sorted().joined(separator: ", "))."
        let visual =
            visualMatch.flatMap { match in
                candidates.first(where: { $0.routing.id == match.candidateID }).map {
                    " Closest declared visual history: \($0.row.title) · \($0.row.id)."
                }
            } ?? ""
        return
            "Capture date: \(date). Vision labels: \(classifications). Recognized text: \(text).\(identity)\(visual)"
    }

    private func appendDecisionLog(
        _ decisions: [PhotoRoutingDecision], candidates: [String: Candidate], stage: String
    ) {
        for decision in decisions {
            if let candidateID = decision.candidateID, let candidate = candidates[candidateID] {
                appendAnalysisLog(
                    "\(stage): \(candidate.row.title) · \(candidate.row.id)",
                    detail: decision.explanation, photoID: decision.photoID, kind: .decision)
            } else {
                appendAnalysisLog(
                    "\(stage): abstained", detail: decision.explanation,
                    photoID: decision.photoID, kind: .abstention)
            }
        }
    }

    private func appendAnalysisLog(
        _ title: String, detail: String? = nil, photoID: String? = nil,
        kind: PhotoAnalysisLogEntry.Kind
    ) {
        analysisLog.append(
            PhotoAnalysisLogEntry(
                id: nextAnalysisLogID, timestamp: Date(), photoID: photoID,
                title: title, detail: detail, kind: kind))
        nextAnalysisLogID += 1
    }

    private func photoLabel(_ id: String) -> String {
        guard let index = items.firstIndex(where: { $0.id == id }) else { return "photo" }
        return "photo \(index + 1)"
    }

    private func analysisLogSummary(_ analysis: PhotoLocalAnalysis) -> String {
        let labels = analysis.classifications.prefix(3).map {
            "\($0.identifier) \(Int(($0.confidence * 100).rounded()))%"
        }.joined(separator: ", ")
        let text = analysis.recognizedText.prefix(2).map(\.text).joined(separator: " · ")
        let labelSummary = labels.isEmpty ? "no classification labels" : "labels: \(labels)"
        let textSummary = text.isEmpty ? "no recognized text" : "text: \(text)"
        return "\(labelSummary) · \(textSummary) · feature print: \(analysis.featurePrint.revision)"
    }

    private static func matchesLifecycle(_ row: EntityRow, policy: PhotoRoutingPolicy?) -> Bool {
        guard let policy else { return true }
        return policy.lifecycleFilters.allSatisfy { filter in
            let values = filter.oneOf + (filter.equals.map { [$0] } ?? [])
            guard !values.isEmpty else { return true }
            guard
                let value = row.raw[filter.field]?.stringValue
                    ?? row.raw[filter.field]?.boolValue.map(String.init)
            else { return true }
            return values.contains(value)
        }
    }

    private static func foundationModelSummary(_ status: PhotoSemanticModelStatus) -> String {
        switch status {
        case .used: "Foundation Models semantic reranking"
        case .unavailable(let reason): "Foundation Models unavailable: \(String(describing: reason))"
        case .failed(let reason): "Foundation Models fallback: \(reason.rawValue)"
        }
    }

    private static func foundationModelLogDetail(_ status: PhotoSemanticModelStatus) -> String {
        switch status {
        case .used:
            "Structured semantic reranking completed on this device."
        case .unavailable:
            "Deterministic Vision, OCR, metadata, and visual matching results remain active."
        case .failed:
            "The model failed safely; deterministic results remain active and no cloud fallback ran."
        }
    }
}

struct PhotoImportGroup: Identifiable, Equatable {
    let id: String
    let title: String
    let evidence: String?
    let photoIDs: [String]
}

private struct PhotoAnalysisDisclosure: View {
    @Bindable var manifest: PhotoImportManifest
    @State private var isExpanded = false

    var body: some View {
        DisclosureGroup(isExpanded: $isExpanded) {
            VStack(alignment: .leading, spacing: 10) {
                if manifest.analysisLog.isEmpty {
                    Text("Decision events will appear here as each photo is analyzed.")
                        .foregroundStyle(.secondary)
                } else {
                    ScrollViewReader { proxy in
                        ScrollView {
                            LazyVStack(alignment: .leading, spacing: 10) {
                                ForEach(manifest.analysisLog) { entry in
                                    PhotoAnalysisLogRow(entry: entry)
                                        .id(entry.id)
                                }
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .onAppear { scrollToLatest(proxy) }
                        .onChange(of: manifest.analysisLog.count) { _, _ in
                            scrollToLatest(proxy)
                        }
                    }
                    .frame(maxHeight: 220)
                    .accessibilityIdentifier("photos.analysis.log")
                }

                Divider()
                VStack(alignment: .leading, spacing: 4) {
                    Label("Vision image classification", systemImage: "eye")
                    Label("Vision text recognition", systemImage: "text.viewfinder")
                    Label(
                        "Vision feature print",
                        systemImage: "point.3.connected.trianglepath.dotted")
                    Label("Capture metadata and date", systemImage: "calendar")
                    if let foundationModelSummary = manifest.foundationModelSummary {
                        Label(foundationModelSummary, systemImage: "apple.intelligence")
                    }
                    Text("No cloud AI is used. Derived analysis data syncs to Cubby.")
                        .foregroundStyle(.secondary)
                }
            }
            .padding(.top, 8)
        } label: {
            VStack(alignment: .leading, spacing: 2) {
                Text("On-device AI decision log")
                if let latest = manifest.analysisLog.last {
                    Text(latest.title)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
        }
        .font(.caption)
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
    }

    private func scrollToLatest(_ proxy: ScrollViewProxy) {
        guard let latest = manifest.analysisLog.last else { return }
        proxy.scrollTo(latest.id, anchor: .bottom)
    }
}

private struct PhotoAnalysisLogRow: View {
    let entry: PhotoAnalysisLogEntry

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: symbol)
                .foregroundStyle(color)
                .frame(width: 16)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .firstTextBaseline) {
                    Text(entry.title).fontWeight(.medium)
                    Spacer(minLength: 8)
                    Text(entry.timestamp.formatted(date: .omitted, time: .standard))
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
                if let detail = entry.detail {
                    Text(detail).foregroundStyle(.secondary).textSelection(.enabled)
                }
            }
        }
        .accessibilityElement(children: .combine)
    }

    private var symbol: String {
        switch entry.kind {
        case .progress: "clock"
        case .decision: "checkmark.circle.fill"
        case .abstention: "questionmark.circle"
        case .fallback: "arrow.triangle.branch"
        case .error: "exclamationmark.triangle.fill"
        }
    }

    private var color: Color {
        switch entry.kind {
        case .progress: .secondary
        case .decision: .green
        case .abstention, .fallback: .orange
        case .error: PorcelainTokens.destructive
        }
    }
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
                            } else if manifest.analysisState == .complete,
                                manifest.needsDestination.contains(id)
                            {
                                Text("No confident match")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
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

enum PhotoImportAnalysisState: Equatable {
    case idle
    case running(String)
    case complete
    case failed(String)

    var isRunning: Bool {
        if case .running = self { return true }
        return false
    }
}

struct PhotoSourceTypeSuggestionGroup: Identifiable, Equatable {
    let source: EntityKey
    let photoIDs: [String]
    var id: EntityKey { source }
}

struct PhotoAnalysisLogEntry: Identifiable, Equatable {
    enum Kind: Equatable {
        case progress
        case decision
        case abstention
        case fallback
        case error
    }

    let id: Int
    let timestamp: Date
    let photoID: String?
    let title: String
    let detail: String?
    let kind: Kind
}

private enum PhotoImportManifestError: LocalizedError {
    case incompleteAssignment

    var errorDescription: String? {
        "Choose a destination for every photo before adding the batch."
    }
}

struct PhotoDestinationOption: Identifiable, Sendable {
    let route: PhotoIngressRoute
    let descriptor: EntityDescriptor
    var id: String { route.id }
    var title: String { descriptor.plural }
    var menuTitle: String {
        switch route.kind {
        case .createRelated:
            "New \(descriptor.singular) from \(EntityCatalog[route.source].singular)"
        case .existingRelated:
            "Existing \(descriptor.singular) for \(EntityCatalog[route.source].singular)"
        case .`self`:
            title
        }
    }

    func menuTitle(for source: EntityRow) -> String {
        switch route.kind {
        case .createRelated:
            "Create \(descriptor.singular) for \(source.id)"
        case .existingRelated:
            "Choose existing \(descriptor.singular) for \(source.id)"
        case .`self`:
            menuTitle
        }
    }
}

struct PhotoSourceTypeOption: Identifiable, Sendable {
    let source: EntityKey
    let options: [PhotoDestinationOption]
    var id: String { source.rawValue }
    var title: String { EntityCatalog[source].plural }
    var outcomeDescription: String {
        let hasRelatedChoices =
            options.contains { $0.route.kind == .existingRelated }
            && options.contains { $0.route.kind == .createRelated }
        if hasRelatedChoices, let related = options.first(where: { $0.route.kind == .createRelated }) {
            return "Choose an existing or new \(related.descriptor.singular)"
        }
        guard
            let primary = options.first(where: { $0.route.choice == .primary })
                ?? options.sorted(by: { $0.id < $1.id }).first
        else { return "Choose an existing record" }
        switch primary.route.kind {
        case .createRelated:
            return "Creates a new \(primary.descriptor.singular)"
        case .existingRelated:
            return "Uses a related \(primary.descriptor.singular)"
        case .`self`:
            return "Attaches to an existing \(EntityCatalog[source].singular)"
        }
    }
}

enum PhotoImportNavigationDestination: Hashable {
    case sourceTypes
    case sourceType(EntityKey)
    case routePicker(source: EntityKey, row: EntityRow)

    static func sourceSelection(
        type: PhotoSourceTypeOption, row: EntityRow
    ) -> PhotoImportNavigationDestination? {
        type.options.count > 1 ? .routePicker(source: type.source, row: row) : nil
    }
}

struct PhotoSuggestedSource: Sendable {
    let type: PhotoSourceTypeOption
    let row: EntityRow
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
    let heroItems: [PhotoSelectionItem]
    let importManifest: PhotoImportManifest?
    let onSelect: (EntityRow) -> Void
    @State private var model: PhotoEntityChooserModel?
    @State private var rankOrder: [String: Int] = [:]
    @State private var rankingGeneration = UUID()
    @State private var isRanking = false

    private var descriptor: EntityDescriptor { EntityCatalog[key] }

    var body: some View {
        VStack(spacing: 0) {
            if !heroItems.isEmpty {
                PhotoImportHero(items: heroItems)
            }
            if let importManifest {
                PhotoAnalysisDisclosure(manifest: importManifest)
            }
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
            .frame(maxHeight: .infinity)
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
        .task(id: rankingInputID) {
            await rankLoadedRows()
        }
        .refreshControl { await model?.refresh() }
    }

    private var rankingInputID: String {
        let dateIDs = model?.dateMatches.map(\.id).joined(separator: ",") ?? ""
        let recentIDs = model?.recentRows.map(\.id).joined(separator: ",") ?? ""
        let searchQuery = model?.search?.query ?? ""
        let searchIDs = model?.searchRows.map(\.id).joined(separator: ",") ?? ""
        return "\(key.rawValue)|\(searchQuery)|\(dateIDs)|\(recentIDs)|\(searchIDs)"
    }

    private var loadedRows: [EntityRow] {
        guard let model else { return [] }
        var seen = Set<String>()
        return (model.dateMatches + model.recentRows + model.searchRows).filter {
            seen.insert($0.id).inserted
        }
    }

    /// Manual type selection still benefits from the prepared import evidence. The task is
    /// view-owned so a new search/type selection cancels stale work without coupling the list
    /// model to Vision or catalog services.
    private func rankLoadedRows() async {
        guard let importManifest else {
            rankOrder = [:]
            isRanking = false
            return
        }
        let rows = loadedRows
        guard !rows.isEmpty else {
            rankOrder = [:]
            isRanking = false
            return
        }
        let generation = UUID()
        rankingGeneration = generation
        isRanking = true
        do {
            let ranked = try await importManifest.rankRows(
                for: key, rows: rows, client: appModel.client)
            try Task.checkCancellation()
            guard rankingGeneration == generation else { return }
            rankOrder = Dictionary(
                uniqueKeysWithValues: ranked.enumerated().map { ($0.element.id, $0.offset) })
        } catch is CancellationError {
            return
        } catch {
            guard rankingGeneration == generation else { return }
            rankOrder = [:]
            Diagnostics.report(error, context: "photos.destination.ranking.\(key.rawValue)")
        }
        if rankingGeneration == generation {
            isRanking = false
        }
    }

    private func ordered(_ rows: [EntityRow]) -> [EntityRow] {
        guard !rankOrder.isEmpty else { return rows }
        return rows.enumerated().sorted { lhs, rhs in
            let left = rankOrder[lhs.element.id] ?? Int.max
            let right = rankOrder[rhs.element.id] ?? Int.max
            return left == right ? lhs.offset < rhs.offset : left < right
        }.map(\.element)
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
            if isRanking {
                Section {
                    ProgressView("Ranking likely matches…")
                        .font(.caption)
                }
            }
            if model.hasDateMatches {
                Section {
                    if let error = model.dateError {
                        Text(error).foregroundStyle(.secondary)
                        Button("Retry date matches") { Task { await model.refresh() } }
                    }
                    ForEach(ordered(model.dateMatches)) { row in destinationRow(row, model: model) }
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
                ForEach(ordered(model.recentRows)) { row in destinationRow(row, model: model) }
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
                    ForEach(ordered(search.rows)) { row in destinationRow(row, model: model) }
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
    let heroItems: [PhotoSelectionItem]
    let importManifest: PhotoImportManifest
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
                    VStack(spacing: 0) {
                        if !heroItems.isEmpty {
                            PhotoImportHero(items: heroItems)
                        }
                        PhotoAnalysisDisclosure(manifest: importManifest)
                        Form {
                            Section {
                                Label(
                                    "Continue to review. Nothing is added until you confirm the batch.",
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
                    }
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
                    Button("Continue") {
                        guard let model, model.canSave else { return }
                        onDraft(model.createBody())
                        dismiss()
                    }
                    .disabled(!(model?.canSave ?? false))
                    .accessibilityIdentifier("photos.destination.create.continue")
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
        for binding in option.route.bindings where binding.field == field.key {
            switch binding.source {
            case .sourceField:
                if PhotoImportManifest.nonNullSourceFieldValue(binding: binding, source: source) != nil {
                    return false
                }
            case .captureDate:
                if captureDate != nil { return false }
            case .sourceId, .constant, .relationItems:
                return false
            }
        }
        guard field.controlKind == .specialized else { return true }
        return field.reference != nil || field.format == "amount" || field.kind == .textArray
    }

    private func createPrefill() -> [String: JSONValue] {
        var result: [String: JSONValue] = [:]
        for binding in option.route.bindings {
            switch binding.source {
            case .sourceId:
                if binding.itemField != nil {
                    result[binding.field] = .array([.string(source.id)])
                } else {
                    result[binding.field] = .string(source.id)
                }
            case .sourceField:
                if let value = PhotoImportManifest.nonNullSourceFieldValue(
                    binding: binding, source: source)
                {
                    result[binding.field] = value
                }
            case .captureDate:
                if let captureDate {
                    result[binding.field] = .string(PlainDate(captureDate).rawValue)
                }
            case .constant:
                if let json = binding.constantJSON,
                    let data = json.data(using: .utf8),
                    let value = try? JSONDecoder().decode(JSONValue.self, from: data)
                {
                    result[binding.field] = value
                }
            case .relationItems:
                if let itemField = binding.itemField {
                    result[binding.field] = .array([.object([itemField: .string(source.id)])])
                }
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
    @Environment(\.dismiss) private var dismiss
    let context: PhotoRelatedContext
    let createOption: PhotoDestinationOption?
    let captureDate: Date?
    let heroItems: [PhotoSelectionItem]
    let importManifest: PhotoImportManifest
    let onSelect: (EntityRow) -> Void
    let onCreate: (PhotoDestinationOption, [String: JSONValue]) -> Void

    @State private var rows: [EntityRow] = []
    @State private var nextOffset: Int?
    @State private var isLoading = true
    @State private var errorMessage: String?
    @State private var search = ""
    @State private var creation: PhotoDestinationOption?
    @State private var listPage = 1

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
            VStack(spacing: 0) {
                if !heroItems.isEmpty {
                    PhotoImportHero(items: heroItems)
                }
                PhotoAnalysisDisclosure(manifest: importManifest)
                Group {
                    if isLoading, rows.isEmpty {
                        LoadingIndicator.screen(label: "Loading related \(descriptor.plural)")
                    } else if let errorMessage, rows.isEmpty {
                        ContentUnavailableView {
                            Label(
                                "Couldn't load \(descriptor.plural)", systemImage: "exclamationmark.triangle")
                        } description: {
                            Text(errorMessage)
                        } actions: {
                            Button("Retry") { Task { await load(reset: true) } }
                        }
                    } else if rows.isEmpty {
                        ContentUnavailableView {
                            Label(
                                "No related \(descriptor.plural)",
                                systemImage: entitySymbol(for: context.option.route.target))
                        } description: {
                            Text("No existing destination matches this photo's capture time or day.")
                        } actions: {
                            if let createOption {
                                Button("Create \(createOption.descriptor.singular)") {
                                    creation = createOption
                                }
                                .buttonStyle(.borderedProminent)
                            }
                        }
                    } else {
                        List {
                            if let createOption {
                                Section {
                                    Button("Create new \(createOption.descriptor.singular)") {
                                        creation = createOption
                                    }
                                }
                            }
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
                .frame(maxHeight: .infinity)
            }
            .navigationTitle("Related \(descriptor.plural)")
            .searchable(text: $search, prompt: "Search name or shortcode")
        }
        .nativeSheet(.editor)
        .task { await load(reset: true) }
        .sheet(item: $creation) { option in
            PhotoRelatedCreateEditor(
                option: option, source: context.source, captureDate: captureDate,
                heroItems: heroItems, importManifest: importManifest
            ) { body in
                onCreate(option, body)
                creation = nil
                dismiss()
            }
        }
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
            listPage = 1
        }
        guard !isLoading || reset else { return }
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        do {
            if let filters = relatedListFilters {
                let page = try await appModel.client.list(
                    descriptor, page: listPage, pageSize: 25,
                    sort: semanticDateKey.map { "-\($0)" } ?? "-updatedAt",
                    filters: filters)
                rows = Dictionary(
                    grouping: rows + page.items, by: \.id
                ).values.compactMap(\.last).sorted { $0.title < $1.title }
                let hasMore = listPage * page.meta.pageSize < page.meta.totalCount
                nextOffset = hasMore ? listPage * page.meta.pageSize : nil
                listPage += 1
                return
            }
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

    /// Prefer the target's manifest-generated relation and date filters when they exist. This
    /// makes Planting → Garden Entry show same-day entries (and ±1 hour for timestamp targets)
    /// without loading an unbounded relationship graph. Routes whose target has no corresponding
    /// filter continue to use the bounded relationship-page fallback above.
    private var relatedListFilters: EntityFilterState? {
        guard
            let relation = descriptor.filters.first(where: {
                $0.targetEntity == context.option.route.source
            })
        else { return nil }
        var result = EntityFilterState()
        if case .param(let name) = relation.wire {
            result.set(.single(context.source.id), for: name)
        } else {
            return nil
        }
        guard
            let dateKey = semanticDateKey, let dateFilter = descriptor.filter(dateKey),
            case .range(let from, let to, _) = dateFilter.wire,
            let captureDate
        else { return result }
        if descriptor.field(dateKey)?.kind == .timestamp {
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            result.set(.single(formatter.string(from: captureDate.addingTimeInterval(-3_600))), for: from)
            result.set(.single(formatter.string(from: captureDate.addingTimeInterval(3_600))), for: to)
        } else {
            let day = PlainDate(captureDate).rawValue
            result.set(.single(day), for: from)
            result.set(.single(day), for: to)
        }
        return result
    }

    private var semanticDateKey: String? {
        PhotoImportCatalog.routingPolicies[descriptor.key]?.temporalFields.first { key in
            guard let field = descriptor.field(key), let filter = descriptor.filter(key),
                case .range = filter.wire
            else { return false }
            return field.kind == .date || field.kind == .timestamp
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
