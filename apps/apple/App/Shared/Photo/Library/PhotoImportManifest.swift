import CubbyKit
import Foundation
import Observation

@MainActor
@Observable
final class PhotoImportManifest {
    let items: [PhotoSelectionItem]
    var selectedIDs: Set<String>
    /// The hero's current item. Drives the default single-photo selection scope (`init`,
    /// `advanceFocusAfterAssignment`); the filmstrip's own focus binding keeps this in sync.
    var focusedItemID: String?
    /// Set by the sheet from `path.isEmpty` (A1): true while a chooser/editor is pushed on top of
    /// the review list. Advancing focus/selection while one is open would move the selection out
    /// from under the photo the person is currently editing there, losing its capture date —
    /// the advance is deferred until the sheet pops back and drains `pendingFocusAdvance`.
    var isNavigating = false {
        didSet {
            guard !isNavigating, pendingFocusAdvance else { return }
            pendingFocusAdvance = false
            advanceFocusAfterAssignment()
        }
    }
    private var pendingFocusAdvance = false
    private var assignments: [String: PhotoDestinationAssignment] = [:]
    private(set) var isCommitting = false
    private(set) var isResolvingSourceRecord = false
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
    /// Developer overlays layer 2: each photo's best-scoring candidate from the deterministic
    /// evidence pass, kept alongside its `PhotoEvidenceScorer.Score` breakdown rather than only the
    /// combined value the routing decision already used.
    private(set) var suggestionScores: [String: PhotoEvidenceScorer.Score] = [:]
    private var duplicateDecisions: [String: PhotoDuplicateDecision] = [:]
    private var analysisGeneration = UUID()
    private var undoSnapshot: [PhotoUndoAssignment] = []
    private var prepared: [String: (PhotoFile, PhotoLocalAnalysis)] = [:]
    private var transaction: PhotoImportTransaction?
    private var analysisTask: Task<Void, Never>?
    private var nextAnalysisLogID = 0
    private let analysisStore: PhotoAnalysisStore

    /// `analysisStore` defaults to a throwaway in-memory store: every production call site
    /// (`PhotosRootView`) passes `AppModel.photoAnalysisStore` explicitly, and so does every test
    /// fixture (`makeManifest(items:)` in `App/Tests/Photos/PhotoTestStores.swift`, which shares
    /// one store across the target instead of racing a fresh `ModelContainer` per manifest). The
    /// default remains only for `#Playground`/`#Preview` fixtures, which build a manifest just to
    /// exercise assignment/commit logic and run one at a time, never concurrently.
    init(
        items: [PhotoSelectionItem],
        analysisStore: PhotoAnalysisStore = PhotoImportManifest.ephemeralAnalysisStore()
    ) {
        self.items = items
        self.analysisStore = analysisStore
        let focused = items.first?.id
        focusedItemID = focused
        selectedIDs = focused.map { Set([$0]) } ?? []
    }

    private static func ephemeralAnalysisStore() -> PhotoAnalysisStore {
        // An in-memory `ModelContainer` has no realistic failure mode on this codebase's target
        // platforms; if this ever throws, the SwiftData runtime itself is broken.
        try! PhotoAnalysisStore.make(inMemory: true)
    }

    /// The filmstrip header's Select all/Deselect all: the default single-photo scope above
    /// covers the common one-record-per-photo case, this covers a same-day batch someone
    /// deliberately selects.
    func toggleSelectAll() {
        selectedIDs = selectedIDs.count == items.count ? [] : Set(items.map(\.id))
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

    /// `createSelf` is never a "pick an existing record" option (there is no record to pick) —
    /// it is the type's "New <singular>" affordance, surfaced separately by
    /// `createSelfOption(for:)`/`createTargetOptions(for:)` and rendered by `PhotoEntityChooser`.
    var destinationOptions: [PhotoDestinationOption] {
        PhotoImportCatalog.ingressRoutes
            .filter { $0.storage != nil && $0.kind != .createSelf }
            .map { PhotoDestinationOption(route: $0, descriptor: EntityCatalog[$0.target]) }
            .sorted { $0.menuTitle < $1.menuTitle }
    }

    /// The manifest's own-record creation route for `type`. Every entity declares exactly one
    /// (8b, compiler-enforced) — enabled, or explicitly disabled with a reason — so this is the
    /// type's "New <singular>" affordance regardless of whether it also has other routes.
    static func createSelfOption(for type: EntityKey) -> PhotoDestinationOption? {
        PhotoImportCatalog.ingressRoutes
            .first { $0.kind == .createSelf && $0.target == type }
            .map { PhotoDestinationOption(route: $0, descriptor: EntityCatalog[$0.target]) }
    }

    /// `createRelated` routes from other sources that create `type` as their target (Garden
    /// entry ← Location/Planting, Meal ← Recipe): the same "New <singular>" row surfaces these as
    /// alternate ways to create `type`, distinguished by which source reference the user fills in.
    static func createTargetOptions(for type: EntityKey) -> [PhotoDestinationOption] {
        PhotoImportCatalog.ingressRoutes
            .filter { $0.kind == .createRelated && $0.target == type }
            .map { PhotoDestinationOption(route: $0, descriptor: EntityCatalog[$0.target]) }
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

    /// What a pushed chooser/editor shows above its list: only the photos the pick will apply
    /// to, with the focused one first so the hero opens on it rather than on the batch's first
    /// photo. Falls back to the whole batch when nothing is selected.
    var scopedHeroItems: [PhotoSelectionItem] {
        let scoped = selectedItems.isEmpty ? items : selectedItems
        guard let focusedItemID, let index = scoped.firstIndex(where: { $0.id == focusedItemID }),
            index != 0
        else { return scoped }
        var ordered = scoped
        ordered.insert(ordered.remove(at: index), at: 0)
        return ordered
    }

    /// The capture date every editor/stage call site prefills from — `scopedHeroItems`, not
    /// `selectedItems`, so an emptied selection (deselect, an auto-assign, the analyzer) still
    /// falls back to the whole batch instead of losing the date entirely (A1: the observed-date
    /// bug was every call site reading `selectedItems.compactMap(\.capturedAt).min()` with no
    /// such fallback).
    var scopedCaptureDate: Date? {
        scopedHeroItems.compactMap(\.capturedAt).min()
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
                // A createSelf draft has no source record, so its header is just the draft's own
                // title ("New <singular>") rather than "<title>  <shortcode>".
                title:
                    first.1.source == nil
                    ? first.1.title : "\(first.1.title)  \(first.1.shortcode)",
                evidence: first.1.evidence,
                photoIDs: values.map { $0.0.id },
                source: first.1.source?.entity,
                sourceRow: first.1.sourceRow,
                decision: first.1.decision)
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
        let targets = Set(drafts.map(\.route.target))
        if targets.count == 1, let target = targets.first {
            return "Add \(photos) + \(drafts.count) \(EntityCatalog[target].plural)"
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

    /// The inverse of `createAlternative(for:)`: given a `.createRelated` option, the paired
    /// `.existingRelated` option for the same source/target/relationPath, when one exists.
    func existingAlternative(for option: PhotoDestinationOption) -> PhotoDestinationOption? {
        guard option.route.kind == .createRelated else { return nil }
        return destinationOptions.first {
            $0.route.kind == .existingRelated
                && $0.route.source == option.route.source
                && $0.route.target == option.route.target
                && $0.route.relationPath == option.route.relationPath
        }
    }

    /// An existing/create pair around `option`, in either direction, when both routes exist for
    /// the same source/target/relationPath. `chooseSourceRecord` auto-resolves such a pair by
    /// querying the existing side first, falling back to create only when nothing matches.
    private func relatedPair(
        for option: PhotoDestinationOption
    ) -> (existing: PhotoDestinationOption, create: PhotoDestinationOption)? {
        switch option.route.kind {
        case .existingRelated:
            return createAlternative(for: option).map { (option, $0) }
        case .createRelated:
            return existingAlternative(for: option).map { ($0, option) }
        case .`self`, .createSelf:
            return nil
        }
    }

    /// The routing policy's related-record lookup for an existing/create pair's "existing" side:
    /// the target's relation filter keyed to the source record, plus the capture-date range
    /// `PhotoEntityChooserModel` already derives for the target descriptor. Shared by the manual
    /// "Choose existing" chooser (`PhotoRelatedDestinationChooser.load`) and `chooseSourceRecord`'s
    /// auto-resolve so a same-day match reads identically from both paths. `nil` when the target
    /// has no filter keyed to the source entity — the caller falls back to the bounded
    /// relationship-page walk.
    static func findRelated(
        option: PhotoDestinationOption, source: EntityRow, captureDate: Date?,
        client: CubbyClient, page: Int = 1, pageSize: Int = 25
    ) async throws -> ListPage<EntityRow>? {
        let descriptor = option.descriptor
        guard
            let relation = descriptor.filters.first(where: { $0.targetEntity == option.route.source }),
            case .param(let name) = relation.wire
        else { return nil }
        var filters = EntityFilterState()
        filters.set(.single(source.id), for: name)
        let semanticDateKey = PhotoEntityChooserModel.semanticDateKey(for: descriptor)
        if let captureDate {
            let dateFilters = PhotoEntityChooserModel.captureDateFilters(
                descriptor: descriptor, key: semanticDateKey, captureDate: captureDate)
            for filterName in dateFilters.names {
                if let value = dateFilters[filterName] { filters.set(value, for: filterName) }
            }
        }
        return try await client.list(
            descriptor, page: page, pageSize: pageSize,
            sort: semanticDateKey.map { "-\($0)" } ?? "-updatedAt", filters: filters)
    }

    /// Routes a tapped source record to its destination. A source type with a `.prompt` route
    /// always asks (that is what `.prompt` means); otherwise the manifest tries the `.primary`
    /// route, auto-resolving an existing/create pair via `findRelated` so a same-day match (say,
    /// an existing Garden Entry) attaches without an extra tap. Ambiguous or unpaired routes fall
    /// back to the interactive picker/chooser/editor a person would reach manually.
    func chooseSourceRecord(
        _ type: PhotoSourceTypeOption, row: EntityRow, client: CubbyClient
    ) async -> PhotoSourceRecordResolution {
        if type.options.contains(where: { $0.route.choice == .prompt }) {
            return .routePicker
        }
        // 8a: a route's `primaryWhen` (at most one per source, compiler-enforced) outranks the
        // unconditional `.primary` when the picked record's field matches one of its values —
        // e.g. a raised-bed Location routes to the Garden Entry route instead of its own gallery.
        let conditionalPrimary = type.options.first { option in
            guard let predicate = option.route.primaryWhen else { return false }
            return row.raw[predicate.field]?.stringValue.map(predicate.values.contains) ?? false
        }
        guard
            let primary =
                conditionalPrimary
                ?? type.options.first(where: { $0.route.choice == .primary })
                ?? type.options.sorted(by: { $0.id < $1.id }).first
        else { return .routePicker }
        // Developer overlays layer 2: the decision this automatic resolution records, shared by
        // every branch below regardless of which physical route (self, existing, create) it ends
        // up taking — `primary`'s predicate/choice is what determined the pick either way.
        let decision = Self.automaticDecision(route: primary.route, row: row)

        let captureDate = scopedCaptureDate

        if let pair = relatedPair(for: primary) {
            isResolvingSourceRecord = true
            defer { isResolvingSourceRecord = false }
            do {
                guard
                    let page = try await Self.findRelated(
                        option: pair.existing, source: row, captureDate: captureDate, client: client)
                else {
                    return stageOrOpenCreateEditor(
                        pair.create, source: row, captureDate: captureDate, decision: decision)
                }
                switch page.items.count {
                case 0:
                    return stageOrOpenCreateEditor(
                        pair.create, source: row, captureDate: captureDate, decision: decision)
                case 1:
                    moveSelected(
                        to: pair.existing, source: row, destination: page.items[0],
                        captureDate: captureDate, decision: .existingSameDay(count: page.items.count))
                    return .resolved
                default:
                    return .relatedChooser(option: pair.existing, page: page)
                }
            } catch {
                Diagnostics.report(error, context: "photos.manifest.findRelated")
                return stageOrOpenCreateEditor(
                    pair.create, source: row, captureDate: captureDate, decision: decision)
            }
        }

        switch primary.route.kind {
        case .`self`:
            moveSelected(to: primary, row: row, decision: decision)
            return .resolved
        case .createRelated:
            return stageOrOpenCreateEditor(primary, source: row, captureDate: captureDate, decision: decision)
        case .existingRelated:
            return .relatedChooser(option: primary, page: nil)
        case .createSelf:
            // Unreachable: `type.options` excludes `createSelf` (see `destinationOptions`); fail
            // safe to the picker rather than staging a self-creation against a chosen source row.
            return .routePicker
        }
    }

    /// The route decision to record for an automatic pick: `primaryWhen` when its predicate
    /// matched `row`'s field, else the plain unconditional `.primary` choice. Shared by
    /// `chooseSourceRecord`'s auto-resolve and the background analyzer's `apply` so the review
    /// sheet's decision reason reads identically from both paths.
    private static func automaticDecision(route: PhotoIngressRoute, row: EntityRow) -> PhotoRouteDecision {
        if let predicate = route.primaryWhen, let value = row.raw[predicate.field]?.stringValue,
            predicate.values.contains(value)
        {
            return .automaticConditional(field: predicate.field, value: value)
        }
        return .automaticPrimary
    }

    private func stageOrOpenCreateEditor(
        _ option: PhotoDestinationOption, source: EntityRow, captureDate: Date?,
        decision: PhotoRouteDecision
    ) -> PhotoSourceRecordResolution {
        if PhotoRelatedCreateEditor.hasOnlyOptionalFields(
            option: option, source: source, captureDate: captureDate)
        {
            stageCreate(
                option: option, source: source,
                body: PhotoRelatedCreateEditor.createPrefill(
                    option: option, source: source, captureDate: captureDate),
                decision: decision)
            return .resolved
        }
        return .createEditor(option: option)
    }

    /// Test-observable accessor for a staged create draft's body. Production code reads bodies
    /// only through `makeBatch()` at commit time.
    func createDraftBody(for photoID: String) -> [String: JSONValue]? {
        assignments[photoID]?.createDraft?.body
    }

    /// Test-observable: exercises the analyzer's suggestion application (using the manifest's own
    /// current generation) without driving the full pipeline. Analysis can offer a record, but a
    /// person must tap it before any assignment is staged.
    func applyRoutingDecisions(_ decisions: [PhotoRoutingDecision], candidates: [String: Candidate]) {
        apply(decisions: decisions, candidates: candidates, generation: analysisGeneration)
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
            analysisState = .running("Searching Cubby records from recognized text…")
            let candidates = await loadCandidates(client: client)
            guard analysisGeneration == generation, !Task.isCancelled else { throw CancellationError() }
            guard !candidates.isEmpty else {
                appendAnalysisLog(
                    "No Cubby records matched recognized text",
                    detail: "On-device Vision results are preserved; choose a destination manually.",
                    kind: .abstention)
                analysisState = .complete
                return
            }
            let candidateCounts = Dictionary(grouping: candidates, by: { $0.option.route.source })
                .map { "\(EntityCatalog[$0.key].plural): \($0.value.count)" }
                .sorted()
                .joined(separator: " · ")
            appendAnalysisLog(
                "Loaded Cubby record candidates", detail: candidateCounts, kind: .progress)
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
                    for: analysis, photoID: item.id, authoritativeOwners: Set(owners),
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
            suggestedSourceTypes[decision.photoID] = candidate.option.route.source
            suggestedSourceRecords[decision.photoID] = candidate.row
            suggestions[decision.photoID] =
                "\(candidate.row.title) · \(candidate.row.id) · \(decision.explanation)"
            // Suggestions deliberately stop here. A source/record tap is the authorization to
            // resolve routes or attach a photo; model output never stages an assignment itself.
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

    func moveSelected(
        to option: PhotoDestinationOption, row: EntityRow, replace: Bool = false,
        decision: PhotoRouteDecision = .user
    ) {
        rememberMove()
        let assignment = PhotoDestinationAssignment(
            route: option.route, source: EntityRef(entity: option.route.source, id: row.id),
            sourceRow: row, recordID: row.id, title: row.title,
            shortcode: row.id, replaceConfirmed: replace, evidence: "Assigned manually",
            decision: decision)
        for id in selectedIDs { assignments[id] = assignment }
        advanceFocusAfterAssignment()
    }

    func moveSelected(
        to option: PhotoDestinationOption, source: EntityRow, destination: EntityRow,
        captureDate: Date? = nil, decision: PhotoRouteDecision = .user
    ) {
        rememberMove()
        let evidence =
            captureDate.map { "Existing \(option.descriptor.singular) · \(PlainDate($0).rawValue)" }
            ?? "Related to \(source.title)"
        let assignment = PhotoDestinationAssignment(
            route: option.route,
            source: EntityRef(entity: option.route.source, id: source.id),
            sourceRow: source,
            recordID: destination.id,
            title: destination.title,
            shortcode: destination.id,
            replaceConfirmed: false,
            evidence: evidence,
            decision: decision)
        for id in selectedIDs { assignments[id] = assignment }
        advanceFocusAfterAssignment()
    }

    /// `source` is `nil` for a `createSelf` draft — the created record has no source of its own.
    func stageCreate(
        option: PhotoDestinationOption, source: EntityRow?, body: [String: JSONValue],
        photoIDs: Set<String>? = nil, decision: PhotoRouteDecision = .user
    ) {
        // A disabled route (project, cookbook, …) is shown so its reason is visible, but is never
        // an actual staging target — belt-and-suspenders alongside the UI disabling its row.
        guard option.route.enabled else { return }
        rememberMove()
        let itemsToStage = items.filter { photoIDs?.contains($0.id) ?? selectedIDs.contains($0.id) }
        guard let source else {
            stageCreateSelf(option: option, body: body, items: itemsToStage, decision: decision)
            return
        }
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
            // Keyed by route + source record + capture day: picking the same source record twice
            // on the same day merges into one draft; two different source records always give two.
            let draft = PhotoCreateDraft(
                id: "\(option.id):\(source.id):\(day)", route: option.route,
                source: EntityRef(entity: option.route.source, id: source.id), body: dayBody,
                title: "\(source.title) · \(source.id)",
                captureDate: group.compactMap(\.capturedAt).first)
            let assignment = PhotoDestinationAssignment(
                route: option.route, source: draft.source, sourceRow: source, recordID: nil,
                title: draft.title,
                shortcode: "New", replaceConfirmed: false,
                evidence: "New \(option.descriptor.singular) · \(day == "undated" ? "date needed" : day)",
                createDraft: draft, decision: decision)
            for item in group { assignments[item.id] = assignment }
        }
        advanceFocusAfterAssignment()
    }

    /// A `createSelf` draft has no source record to key or split by day — unlike the path above,
    /// every "New <entity>" tap is its own record (even for a same-day batch), and every selected
    /// photo goes to that one record regardless of its individual capture date.
    private func stageCreateSelf(
        option: PhotoDestinationOption, body: [String: JSONValue], items itemsToStage: [PhotoSelectionItem],
        decision: PhotoRouteDecision = .user
    ) {
        guard !itemsToStage.isEmpty else {
            advanceFocusAfterAssignment()
            return
        }
        // A1: re-derive the capture-date binding from the photos actually being staged, exactly
        // like `stageCreate`'s per-day grouping — `body` may have been prefilled earlier (e.g.
        // against a since-changed selection) and must not be trusted for this field.
        var body = body
        let captureDate = itemsToStage.compactMap(\.capturedAt).min()
        if let binding = option.route.bindings.first(where: { $0.source == .captureDate }) {
            if let captureDate {
                body[binding.field] = .string(PlainDate(captureDate).rawValue)
            } else {
                body.removeValue(forKey: binding.field)
            }
        }
        let title = "New \(option.descriptor.singular)"
        let draft = PhotoCreateDraft(
            id: "\(option.id):new:\(UUID().uuidString)", route: option.route,
            source: nil, body: body, title: title,
            captureDate: captureDate)
        let assignment = PhotoDestinationAssignment(
            route: option.route, source: nil, sourceRow: nil, recordID: nil,
            title: title, shortcode: "New", replaceConfirmed: false, evidence: title,
            createDraft: draft, decision: decision)
        for item in itemsToStage { assignments[item.id] = assignment }
        advanceFocusAfterAssignment()
    }

    /// After every successful move/stage, hand focus and selection to the next unassigned photo
    /// so the following pick applies there instead of re-touching the just-assigned photo(s).
    /// Deferred while a chooser/editor is pushed (`isNavigating`) — see that property's doc.
    private func advanceFocusAfterAssignment() {
        guard !isNavigating else {
            pendingFocusAdvance = true
            return
        }
        let next = needsDestination.first
        focusedItemID = next
        selectedIDs = next.map { Set([$0]) } ?? []
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
                    sourceEntity: assignment.source?.entity,
                    sourceID: assignment.source?.id,
                    draftID: draft.id,
                    draftRouteID: draft.route.id, draftBody: draft.body,
                    draftCapturedAt: draft.captureDate,
                    replaceConfirmed: assignment.replaceConfirmed,
                    duplicateChoice: duplicateChoice(for: item.id))
            }
            // Every non-draft assignment (existing/self) always has a source; only a createSelf
            // draft (handled above) omits one.
            guard let recordID = assignment.recordID, let source = assignment.source else {
                throw PhotoImportManifestError.incompleteAssignment
            }
            return PhotoImportBatchItem(
                clientID: item.id, file: file, analysis: analysis,
                routeID: assignment.route.id,
                sourceEntity: source.entity,
                sourceID: source.id,
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
            let file = files[index]
            let analysis = analyses[index]
            prepared[item.id] = (file, analysis)
            await persistFullAnalysis(analysis, for: item.id)
        }
    }

    /// Writes the full analysis (hash + classify + OCR + feature print) into the on-device store
    /// so a later Diagnostics open is instant and the classification sweep skips this photo.
    /// Best-effort: a store write failure never blocks the import itself.
    private func persistFullAnalysis(_ analysis: PhotoLocalAnalysis, for localIdentifier: String) async {
        guard let data = try? JSONEncoder.cubby().encode(analysis) else { return }
        try? await analysisStore.upsertFullAnalysis(
            localIdentifier: localIdentifier, analysis: data, version: PhotoLocalAnalysis.currentVersion,
            categories: PhotoCategoryHit.matchedCategories(for: analysis.classifications),
            topLabels: PhotoCategoryHit.topLabels(for: analysis.classifications),
            classifyVersion: PhotoClassificationSweep.classifyVersion)
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
        let matches = PhotoEvidenceScorer.policyMatches(analysis)
        let candidates = optionsByKey.keys.compactMap { key -> (EntityKey, Double, String)? in
            guard let match = matches[key], match.meetsMinimumScore,
                let identifier = match.classifierIdentifier, let confidence = match.classifierConfidence
            else { return nil }
            return (key, confidence, identifier)
        }
        guard let best = candidates.max(by: { $0.1 < $1.1 }) else { return nil }
        return (best.0, "Suggested: \(EntityCatalog[best.0].plural) · \(best.2)")
    }

    /// Internal (not `private`) so `applyRoutingDecisions` can build one from a test target.
    struct Candidate: Sendable {
        let option: PhotoDestinationOption
        let row: EntityRow
        let routing: PhotoRoutingCandidate
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
        let optionsBySource = Dictionary(
            uniqueKeysWithValues: sourceTypeOptions.compactMap {
                type -> (EntityKey, PhotoDestinationOption)? in
                let option =
                    type.options.first(where: { $0.route.choice == .primary })
                    ?? type.options.sorted { $0.id < $1.id }.first
                return option.map { (type.source, $0) }
            })
        let allowedSources = Set(optionsBySource.keys)
        var candidates: [Candidate] = []
        var candidateIDs = Set<String>()

        for item in items {
            guard let analysis = prepared[item.id]?.1 else { continue }
            for query in PhotoRecordSearch.queries(for: analysis) {
                do {
                    let matches = try await PhotoRecordSearch.matches(
                        query: query, allowedSources: allowedSources, client: client)
                    for match in matches {
                        guard let option = optionsBySource[match.key] else { continue }
                        let policy = PhotoImportCatalog.routingPolicies[option.route.source]
                        guard Self.matchesLifecycle(match.row, policy: policy),
                            !(option.route.requiresReplaceConfirmation && match.row.imageURL != nil)
                        else { continue }
                        let candidateID = "\(option.id):\(match.row.id)"
                        guard candidateIDs.insert(candidateID).inserted else { continue }
                        let description =
                            ([match.row.title, match.row.id]
                            + PhotoEvidenceScorer.candidateFieldValues(match.row, policy: policy))
                            .joined(separator: " · ")
                        candidates.append(
                            Candidate(
                                option: option,
                                row: match.row,
                                routing: PhotoRoutingCandidate(
                                    id: candidateID, routeID: option.id, description: description,
                                    sourceEntity: option.route.source, sourceID: match.row.id)))
                    }
                } catch is CancellationError {
                    return []
                } catch {
                    Diagnostics.report(error, context: "photos.manifest.recordSearch")
                    appendAnalysisLog(
                        "Cubby record search failed", detail: error.localizedDescription,
                        photoID: item.id, kind: .fallback)
                }
            }
        }
        return Array(candidates.prefix(FoundationModelsPhotoSemanticModel.maximumCandidates))
    }

    /// One ranked row plus the evidence score that placed it there (developer overlays layer 3:
    /// rank position, `combined`, and which lane — date/recent/search/visual — the row's identity
    /// component came from).
    struct RankedRow {
        let row: EntityRow
        let score: PhotoEvidenceScorer.Score
    }

    /// Ranks a manually chosen natural-source catalog with the same prepared evidence used for
    /// automatic suggestions. Visual evidence is deliberately delegated to the manifest catalog
    /// matcher; it only follows declared paths to directly owned gallery attachments.
    func rankRows(
        for source: EntityKey, rows: [EntityRow], client: CubbyClient
    ) async throws -> [RankedRow] {
        guard !rows.isEmpty, !prepared.isEmpty else { return rows.map { RankedRow(row: $0, score: .zero) } }
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
        let ranked = rows.enumerated().map { index, row -> (RankedRow, Int) in
            let identity: Double =
                visualMatches.values.contains { $0.candidateID == "\(source.rawValue):\(row.id)" } ? 1 : 0
            // Component-wise max across every prepared analysis, then the shared combine formula —
            // identity is per-row (not per-analysis), so it is unchanged by the reduce.
            let evidence = analyses.values.reduce(
                PhotoEvidenceScorer.Score(text: 0, classifier: 0, date: 0, identity: identity)
            ) { acc, analysis in
                let next = PhotoEvidenceScorer.score(
                    analysis: analysis, row: row, policy: policy, identity: identity)
                return PhotoEvidenceScorer.Score(
                    text: max(acc.text, next.text), classifier: max(acc.classifier, next.classifier),
                    date: max(acc.date, next.date), identity: identity)
            }
            return (RankedRow(row: row, score: evidence), index)
        }
        return ranked.sorted { lhs, rhs in
            lhs.0.score.combined == rhs.0.score.combined
                ? lhs.1 < rhs.1 : lhs.0.score.combined > rhs.0.score.combined
        }.map(\.0)
    }

    private func deterministicCandidateIDs(
        for analysis: PhotoLocalAnalysis,
        photoID: String,
        authoritativeOwners: Set<String>,
        visualMatch: PhotoVisualEvidenceMatch?,
        among candidates: [Candidate]
    ) -> [String] {
        let scored = candidates.compactMap { candidate -> (String, PhotoEvidenceScorer.Score, Double)? in
            guard let policy = PhotoImportCatalog.routingPolicies[candidate.option.route.source]
            else { return nil }
            let identity: Double =
                authoritativeOwners.contains(candidate.row.id)
                    || visualMatch?.candidateID == candidate.routing.id ? 1 : 0
            let score = PhotoEvidenceScorer.score(
                analysis: analysis, row: candidate.row, policy: policy, identity: identity)
            return (candidate.routing.id, score, policy.minimumScore)
        }.sorted { $0.1.combined > $1.1.combined }
        // Developer overlays layer 2: keep the winning candidate's full breakdown (text/date/
        // identity/classifier), not only the `combined` value the routing decision below uses.
        if let best = scored.first { suggestionScores[photoID] = best.1 }
        guard let first = scored.first, first.1.combined >= first.2 else { return [] }
        let policy = candidates.first(where: { $0.routing.id == first.0 }).flatMap {
            PhotoImportCatalog.routingPolicies[$0.option.route.source]
        }
        let runnerUp = scored.dropFirst().first?.1.combined ?? 0
        guard first.1.combined - runnerUp >= (policy?.minimumMargin ?? 1) else { return [] }
        return scored.prefix(5).filter { $0.1.combined >= $0.2 }.map(\.0)
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

private enum PhotoImportManifestError: LocalizedError {
    case incompleteAssignment

    var errorDescription: String? {
        "Choose a destination for every photo before adding the batch."
    }
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
