import CubbyKit
import SwiftUI

/// The state behind the bulk "Add to import run" flow: pick or start a `photo_inventory` run,
/// materialize the selection, then hand it to `PhotoImportRunSession`. There is no per-photo
/// destination step — `preparedPhotos` goes into the run in picker order and that is the entire
/// decision the user makes here, matching the "select photos and that's it" requirement this
/// flow exists for, up to `SharedConstants.photoRunImageLimit` per run (the manifest-based
/// `PhotoImportManifest` owns per-photo routing).
@MainActor
@Observable
final class PhotoImportRunFlow {
    enum Step: Equatable {
        case choosingRun
        case preparing(completed: Int, total: Int)
        case preparationNeedsAttention
        case running
    }

    private(set) var step: Step = .choosingRun
    private(set) var openRuns: [EntityRow] = []
    private(set) var loadingRuns = false
    private(set) var prepareError: String?
    private(set) var preparingWaitingReason: String?
    private(set) var failedPreparationItems: [PhotoSelectionItem] = []
    private(set) var preparationErrors: [String: String] = [:]
    private(set) var unavailablePreparationItems: [PhotoImportSelectionCheckpoint.Unavailable] = []

    var notes = ""
    var usesExternalProcessor = false
    private(set) var notifyWhenReady = false
    private(set) var notificationError: String?
    var selectedOwnerID: LedgerPartyShortcode?
    var selectedOwnerName: String?

    let session: PhotoImportRunSession
    private var preparedPhotos: [PhotoImportRunPhoto] = []
    private var flowTask: Task<Void, Never>?
    private var interrupted = false
    private var userCancelled = false
    private var selectedItems: [PhotoSelectionItem] = []
    private var selectedRunID: RunShortcode?
    private var selectedCreateRun: PhotoImportCreateRunInput?
    private let waitForPreparationConditions: PhotoImportConditions.Wait
    private let materializePhoto: @MainActor (PhotoSelectionItem) async throws -> PhotoFile
    private let activityID = "photo-run-upload-\(UUID().uuidString)"
    private var startedAt: Date?
    private let checkpointURL: URL?
    private var selectionCheckpointURL: URL? {
        checkpointURL?.deletingPathExtension().appendingPathExtension("selection")
    }

    init(
        client: CubbyClient, activityCenter: BackgroundActivityCenter? = nil, checkpointURL: URL? = nil,
        waitForPreparationConditions: @escaping PhotoImportConditions.Wait = { changed in
            try await PhotoImportConditions.shared.wait(report: changed)
        },
        materializePhoto: @escaping @MainActor (PhotoSelectionItem) async throws -> PhotoFile = {
            try await $0.materialize()
        }
    ) {
        self.checkpointURL = checkpointURL
        self.waitForPreparationConditions = waitForPreparationConditions
        self.materializePhoto = materializePhoto
        session = PhotoImportRunSession(
            uploader: PhotoImportRunUploader(
                client: client, checkpointURL: checkpointURL,
                selectionCheckpointURL: checkpointURL?.deletingPathExtension().appendingPathExtension(
                    "selection"),
                waitForConditions: { changed in try await PhotoImportConditions.shared.wait(report: changed)
                },
                waitingReason: { PhotoImportConditions.shared.waitingReason },
                systemConditionsFavorable: { PhotoImportConditions.shared.waitingReason == nil },
                cancelUploads: { await PhotoImportBackgroundUpload.shared.cancel(files: $0) },
                put: { file, url, contentType in
                    try await PhotoImportBackgroundUpload.shared.put(
                        file: file, to: url, contentType: contentType)
                }), reportDiagnostic: { error in Diagnostics.report(error, context: "photos.import.upload") })
        activityCenter?.register(self)
    }

    func setNotificationPreference(_ enabled: Bool) {
        notifyWhenReady = enabled
        notificationError = nil
        guard enabled else { return }
        Task {
            do {
                let granted = try await PhotoImportNotificationCoordinator.shared.requestPermission()
                notifyWhenReady = granted
                if !granted { notificationError = "Notifications are disabled in system settings." }
            } catch {
                Diagnostics.report(error, context: "photos.import.notification.permission")
                notificationError = error.userMessage
                notifyWhenReady = false
            }
        }
    }

    func recover(from checkpointURL: URL) throws {
        let state = try JSONDecoder().decode(
            PhotoImportRunCheckpoint.self, from: Data(contentsOf: checkpointURL))
        notifyWhenReady = state.notificationsRequested
        preparedPhotos = try state.materializedPhotos(at: checkpointURL)
        step = .running
        startedAt = .now
        session.start(
            preparedPhotos, runID: state.runID, createRun: state.createRun,
            notificationsRequested: notifyWhenReady)
    }

    func interrupt() {
        interrupted = true
        flowTask?.cancel()
        session.interrupt()
    }

    func continueAutomatically() {
        guard interrupted, !userCancelled, flowTask == nil, !session.hasActiveWork else { return }
        interrupted = false
        if session.phase != .idle, !preparedPhotos.isEmpty {
            retryFailedUploads()
        } else if !selectedItems.isEmpty {
            begin(
                items: selectedItems, runID: selectedRunID, createRun: selectedCreateRun,
                persistSelection: false
            ) { [self] in
                session.start(
                    preparedPhotos, runID: selectedRunID, createRun: selectedCreateRun,
                    notificationsRequested: notifyWhenReady)
            }
        }
    }

    var preparedPhotoIDs: [String] { preparedPhotos.map(\.id) }
    func waitForPreparation() async { await flowTask?.value }

    var liveActivityBatchID: String { checkpointURL?.deletingPathExtension().lastPathComponent ?? activityID }

    var selectedPhotos: [PhotoSelectionItem] { selectedItems }
    var needsAttention: Bool {
        guard !userCancelled else { return false }
        if step == .preparationNeedsAttention { return true }
        if case .failed = session.phase { return true }
        return false
    }
    var canContinuePreparation: Bool { !preparedPhotos.isEmpty }

    private func materialize(_ item: PhotoSelectionItem) async throws -> PhotoImportRunPhoto {
        preparingWaitingReason = PhotoImportConditions.shared.waitingReason
        try await waitForPreparationConditions { reason in
            await MainActor.run { self.preparingWaitingReason = reason }
        }
        preparingWaitingReason = nil
        let file = try await materializePhoto(item)
        return PhotoImportRunPhoto(
            id: item.id, file: file,
            provenance: PhotoAnalysisProvenance(
                source: item.provenanceSource,
                localIdentifier: item.localIdentifier, filename: file.filename),
            library: item.importLibraryFields(file: file))
    }

    func retryPreparation(_ id: String? = nil) {
        guard flowTask == nil else { return }
        let failures = failedPreparationItems.filter { id == nil || $0.id == id }
        step = .preparing(completed: preparedPhotos.count, total: selectedItems.count)
        flowTask = Task { [self] in
            for item in failures {
                do {
                    preparedPhotos.append(try await materialize(item))
                    failedPreparationItems.removeAll { $0.id == item.id }
                    preparationErrors.removeValue(forKey: item.id)
                } catch is CancellationError {
                    flowTask = nil
                    step = .preparationNeedsAttention
                    return
                } catch {
                    Diagnostics.report(error, context: "photos.import.retryPreparation")
                    preparationErrors[item.id] = error.userMessage
                }
            }
            flowTask = nil
            if failedPreparationItems.isEmpty && unavailablePreparationItems.isEmpty {
                startPreparedSelection()
            } else {
                step = .preparationNeedsAttention
            }
        }
    }

    func continueWithoutPreparationFailures() {
        guard canContinuePreparation else { return }
        startPreparedSelection()
    }

    private func startPreparedSelection() {
        preparedPhotos = selectedItems.compactMap { item in preparedPhotos.first { $0.id == item.id } }
        step = .running
        selectedCreateRun?.imageCount = preparedPhotos.count
        session.start(
            preparedPhotos, runID: selectedRunID, createRun: selectedCreateRun,
            notificationsRequested: notifyWhenReady)
    }

    var hasPendingWork: Bool { isBusy || (interrupted && !userCancelled) }

    var isBusy: Bool {
        if case .preparing = step { return true }
        return step == .running && session.hasActiveWork
    }

    /// Best-effort: an empty or failed list still leaves "start a new run" available.
    func loadOpenRuns(client: CubbyClient) async {
        loadingRuns = true
        defer { loadingRuns = false }
        var filters = EntityFilterState()
        filters.set(.many(["running", "needs_review", "completed"]), for: "status")
        filters.set(.many(["photo_inventory"]), for: "purpose")
        openRuns =
            (try? await client.list(EntityCatalog[.run], pageSize: 50, filters: filters))?
            .items ?? []
    }

    func startNewRun(items: [PhotoSelectionItem], client: CubbyClient) {
        let createRun = PhotoImportCreateRunInput(
            ledgerPartyId: selectedOwnerID, notes: notes.isEmpty ? nil : notes,
            processor: usesExternalProcessor ? .external : .cubby,
            clientBatchId: checkpointURL?.deletingPathExtension().lastPathComponent ?? UUID().uuidString,
            imageCount: items.count)
        begin(items: items, createRun: createRun) { [self] in
            session.start(preparedPhotos, createRun: createRun, notificationsRequested: notifyWhenReady)
        }
    }

    func useExistingRun(_ id: RunShortcode, items: [PhotoSelectionItem]) {
        begin(items: items, runID: id) { [self] in
            session.start(preparedPhotos, runID: id, notificationsRequested: notifyWhenReady)
        }
    }

    func noteRecoveryFailure(_ error: any Error) {
        prepareError = error.userMessage
        step = .preparationNeedsAttention
    }

    func retryRecovery() {
        Task {
            do {
                if let checkpointURL, FileManager.default.fileExists(atPath: checkpointURL.path) {
                    try recover(from: checkpointURL)
                } else if let url = selectionCheckpointURL {
                    try await recoverSelection(from: url)
                }
            } catch {
                Diagnostics.report(error, context: "photos.import.retryRecovery")
                noteRecoveryFailure(error)
            }
        }
    }

    func recoverSelection(from url: URL) async throws {
        let archive = try JSONDecoder().decode(
            PhotoImportSelectionCheckpoint.self, from: Data(contentsOf: url))
        guard !archive.cancelled else { return }
        notifyWhenReady = archive.notificationsRequested
        let restored = await archive.selection()
        unavailablePreparationItems = restored.unavailable
        selectedRunID = archive.runID
        selectedCreateRun = archive.createRun
        if restored.items.isEmpty {
            step = .preparationNeedsAttention
            return
        }
        let items = restored.items
        begin(items: items, runID: archive.runID, createRun: archive.createRun, persistSelection: false) {
            [self] in
            session.start(
                preparedPhotos, runID: archive.runID, createRun: archive.createRun,
                notificationsRequested: notifyWhenReady)
        }
    }

    /// Retries the retained selection; confirmed photos keep their original server identifiers.
    func retryFailedUploads() {
        guard !preparedPhotos.isEmpty, flowTask == nil else { return }
        step = .running
        session.start(
            preparedPhotos, runID: selectedRunID, createRun: selectedCreateRun,
            notificationsRequested: notifyWhenReady)
    }

    /// Stops whichever phase is in flight: the materialize loop below checks `Task.isCancelled`
    /// per photo, and `PhotoImportRunSession.cancel()` stops further upload chunks (already
    /// finalized ones stay finalized — the server has them).
    func cancel() {
        userCancelled = true
        if let url = selectionCheckpointURL {
            do {
                var archive = try JSONDecoder().decode(
                    PhotoImportSelectionCheckpoint.self, from: Data(contentsOf: url))
                archive.cancelled = true
                try JSONEncoder().encode(archive).write(to: url, options: .atomic)
            } catch { Diagnostics.report(error, context: "photos.import.cancelSelection") }
        }
        let preparationTask = flowTask
        preparationTask?.cancel()
        session.cancel()
        if let url = selectionCheckpointURL {
            Task {
                await preparationTask?.value
                let files = url.deletingPathExtension().appendingPathExtension("files")
                do {
                    if FileManager.default.fileExists(atPath: files.path) {
                        try FileManager.default.removeItem(at: files)
                    }
                    if FileManager.default.fileExists(atPath: url.path) {
                        try FileManager.default.removeItem(at: url)
                    }
                } catch { Diagnostics.report(error, context: "photos.import.cancelSelection.cleanup") }
            }
        }
    }

    private func begin(
        items: [PhotoSelectionItem], runID: RunShortcode? = nil, createRun: PhotoImportCreateRunInput? = nil,
        persistSelection: Bool = true, start: @escaping () -> Void
    ) {
        guard flowTask == nil else { return }
        if persistSelection, let url = selectionCheckpointURL {
            do {
                _ = try PhotoImportSelectionCheckpoint.prepare(
                    items: items, runID: runID, createRun: createRun,
                    notificationsRequested: notifyWhenReady, at: url)
            } catch {
                Diagnostics.report(error, context: "photos.import.persistSelection")
                prepareError = error.localizedDescription
                return
            }
        }
        selectedItems = items
        selectedRunID = runID
        selectedCreateRun = createRun
        startedAt = .now
        step = .preparing(completed: 0, total: items.count)
        prepareError = nil
        flowTask = Task { [self] in
            var prepared = preparedPhotos
            failedPreparationItems = []
            preparationErrors = [:]
            for (index, item) in items.enumerated() {
                if Task.isCancelled {
                    preparedPhotos = prepared
                    failedPreparationItems = items.filter { item in !prepared.contains { $0.id == item.id } }
                    step = .preparationNeedsAttention
                    flowTask = nil
                    return
                }
                if prepared.contains(where: { $0.id == item.id }) { continue }
                do {
                    prepared.append(try await materialize(item))
                    step = .preparing(completed: index + 1, total: items.count)
                } catch is CancellationError {
                    preparedPhotos = prepared
                    failedPreparationItems = items.filter { item in !prepared.contains { $0.id == item.id } }
                    step = .preparationNeedsAttention
                    flowTask = nil
                    return
                } catch {
                    Diagnostics.report(error, context: "photos.import.prepare")
                    failedPreparationItems.append(item)
                    preparationErrors[item.id] = error.userMessage
                    step = .preparing(completed: index + 1, total: items.count)
                }
            }
            preparedPhotos = prepared
            if Task.isCancelled {
                step = .preparationNeedsAttention
                flowTask = nil
                return
            }
            if failedPreparationItems.isEmpty && unavailablePreparationItems.isEmpty {
                step = .running
                start()
            } else {
                step = .preparationNeedsAttention
            }
            flowTask = nil
        }
    }
}

extension PhotoImportRunFlow: BackgroundActivitySource {
    var currentActivities: [BackgroundActivity] {
        let progress: Double?
        let detail: String
        switch step {
        case .choosingRun, .preparationNeedsAttention:
            return []
        case .preparing(let completed, let total):
            progress = total > 0 ? 0.2 * Double(completed) / Double(total) : nil
            detail = preparingWaitingReason ?? "Preparing \(completed) of \(total)"
        case .running:
            guard session.hasActiveWork else { return [] }
            let state = session.progress
            progress =
                state.total > 0
                ? 0.2 + 0.8 * Double(state.transferred + state.analyzed) / Double(2 * state.total)
                : nil
            detail =
                state.waitingReason
                ?? "Transferred \(state.transferred), imported \(state.uploaded) of \(state.total)"
        }
        return [
            BackgroundActivity(
                id: activityID, kind: .upload, title: "Adding photos to run", phase: .running,
                progress: progress, detail: detail, startedAt: startedAt ?? .now,
                link: .localActivity(activityID), isUserInitiated: true, isCancellable: false)
        ]
    }
}

/// One bulk-upload surface for adding a photo selection to a photo-inventory import run.
/// Presented like `PhotoDestinationSheet`'s `PhotoSelectionBatch`: the caller builds `flow` once per
/// batch and owns it, rather than seeding it from this view's own `@State` (apps/apple/AGENTS.md,
/// "Traps that cost real time" — a re-presented `.sheet(item:)` can otherwise show stale state).
struct PhotoImportRunSheet: View {
    let items: [PhotoSelectionItem]
    @Bindable var flow: PhotoImportRunFlow
    let onDone: (RunShortcode) -> Void

    @Environment(AppModel.self) private var appModel
    @Environment(\.dismiss) private var dismiss
    @State private var pickingOwner = false

    var body: some View {
        NavigationStack {
            content
                .navigationTitle("Add to import run")
                #if os(iOS)
                    .navigationBarTitleDisplayMode(.inline)
                #endif
                .toolbar { toolbar }
        }
        .nativeSheet(.photoImport)
        .task { await flow.loadOpenRuns(client: appModel.client) }
        .sheet(isPresented: $pickingOwner) {
            EntityPickerSheet(
                target: .ledgerParty, selected: [flow.selectedOwnerID].compactMap { $0 }
            ) { picks in
                guard let owner = picks.first else { return }
                flow.selectedOwnerID = owner.id
                flow.selectedOwnerName = owner.title
            }
        }
    }

    @ViewBuilder private var content: some View {
        switch flow.step {
        case .choosingRun:
            choosingRunView
        case .preparing(let completed, let total):
            preparingView(completed, total)
        case .preparationNeedsAttention:
            preparationFailuresView
        case .running:
            RunningView(
                session: flow.session, onRetryUpload: flow.retryFailedUploads,
                onRetryAnalysis: flow.session.retryFailedAnalysis)
        }
    }

    private var preparationFailuresView: some View {
        List {
            Section("Photos need attention") {
                if let error = flow.prepareError {
                    Text(error).foregroundStyle(FieldGuideTokens.destructive).textSelection(.enabled)
                    Button("Retry recovery") { flow.retryRecovery() }
                }
                ForEach(flow.failedPreparationItems) { item in
                    VStack(alignment: .leading, spacing: FieldGuideTokens.Space.xs) {
                        Text(item.importFilename)
                        if let error = flow.preparationErrors[item.id] {
                            Text(error).foregroundStyle(FieldGuideTokens.destructive).textSelection(.enabled)
                        }
                        Button("Retry this photo") { flow.retryPreparation(item.id) }
                    }
                }
                ForEach(flow.unavailablePreparationItems) { item in
                    VStack(alignment: .leading, spacing: FieldGuideTokens.Space.xs) {
                        Text(item.entry.filename ?? "Unavailable photo")
                        Text(item.error).foregroundStyle(FieldGuideTokens.destructive).textSelection(.enabled)
                        Button("Retry recovery") { flow.retryRecovery() }
                    }
                }
            }
            Section {
                if !flow.failedPreparationItems.isEmpty {
                    Button("Retry failed photos") { flow.retryPreparation() }
                }
                Button("Continue without failed photos") { flow.continueWithoutPreparationFailures() }
                    .disabled(!flow.canContinuePreparation)
            } footer: {
                Text("Failed photos stay selected. Continuing imports only the photos that are ready.")
            }
        }
    }

    private var choosingRunView: some View {
        List {
            if let error = flow.prepareError {
                Section {
                    Label(error, systemImage: "exclamationmark.triangle")
                        .foregroundStyle(FieldGuideTokens.destructive)
                }
            }
            Section {
                Button {
                    pickingOwner = true
                } label: {
                    LabeledContent("Owner", value: flow.selectedOwnerName ?? "You (signed-in member)")
                }
                .accessibilityIdentifier("photos.run.owner")
                Picker("Process with", selection: $flow.usesExternalProcessor) {
                    Text("Cubby / Pi").tag(false)
                    Text("Claude / Codex").tag(true)
                }
                .accessibilityIdentifier("photos.run.processor")
                Toggle(
                    "Notify me when ready or attention is needed",
                    isOn: Binding(
                        get: { flow.notifyWhenReady }, set: { flow.setNotificationPreference($0) }))
                if let error = flow.notificationError {
                    Text(error).foregroundStyle(FieldGuideTokens.destructive)
                }
                DisclosureGroup("Add a note") {
                    TextField("Notes for this batch", text: $flow.notes, axis: .vertical)
                }
                Button {
                    flow.startNewRun(items: items, client: appModel.client)
                } label: {
                    Label(
                        "Import \(items.count) photo\(items.count == 1 ? "" : "s")",
                        systemImage: "square.and.arrow.up"
                    )
                    .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .accessibilityIdentifier("photos.run.startNew")
            } header: {
                Text("New run")
            } footer: {
                Text(
                    "\(items.count) photo\(items.count == 1 ? "" : "s") will upload. The agent will propose item groups for you to review before anything is created."
                )
            }
            if flow.loadingRuns {
                Section { LoadingIndicator(label: "Loading open runs").controlSize(.small) }
            } else if !flow.openRuns.isEmpty {
                Section("Open runs") {
                    Text(
                        "Adding photos to a Cubby / Pi run replaces all unapproved groups and edits. Approved items are retained."
                    )
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    ForEach(flow.openRuns) { row in
                        Button(row.title) {
                            flow.useExistingRun(row.id, items: items)
                        }
                        .accessibilityIdentifier("photos.run.existing.\(row.id)")
                    }
                }
            }
        }
    }

    private func preparingView(_ completed: Int, _ total: Int) -> some View {
        VStack(spacing: FieldGuideTokens.Space.md) {
            ProgressView(value: Double(completed), total: Double(max(total, 1)))
            Text(flow.preparingWaitingReason ?? "Preparing \(completed) of \(total)…")
                .font(.fieldGuideBody)
                .foregroundStyle(FieldGuideTokens.graphiteSecondary)
        }
        .padding(FieldGuideTokens.Space.md)
    }

    @ToolbarContentBuilder private var toolbar: some ToolbarContent {
        ToolbarItem(placement: .cancellationAction) {
            Button("Done") {
                if let runID = flow.session.runID { finish(runID) } else { dismiss() }
            }
            .accessibilityIdentifier("photos.run.done")
        }
        if flow.isBusy || flow.needsAttention {
            ToolbarItem(placement: .primaryAction) {
                Button("Cancel remaining work", role: .destructive) { flow.cancel() }
            }
        }
    }

    private func finish(_ runID: RunShortcode) {
        onDone(runID)
        dismiss()
    }
}

/// The upload/analysis progress screen, driven directly by `PhotoImportRunSession`'s own
/// `@Observable` state — SwiftUI already re-renders on `session.phase`/`session.progress` changes,
/// so this needs no separate progress bridge.
private struct RunningView: View {
    @Bindable var session: PhotoImportRunSession
    let onRetryUpload: () -> Void
    let onRetryAnalysis: () -> Void
    @Environment(AppModel.self) private var appModel
    @State private var review = RunReviewSession()

    private var runLinkTitle: String {
        review.review?.review.proposals.contains { $0.state == .proposed } == true
            ? "Review item groups" : "View import"
    }

    private func runDestination(_ runID: String) -> RunConsoleView {
        RunConsoleView(
            runID: runID,
            initialSection: review.review?.review.proposals.contains { $0.state == .proposed } == true
                ? .photoReview : nil)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: FieldGuideTokens.Space.md) {
            Text(stageTitle)
                .font(.headline)
            ProgressView(
                value: Double(session.progress.transferred), total: Double(max(session.progress.total, 1))
            )
            Text("Transferred \(session.progress.transferred) of \(session.progress.total)")
                .font(.fieldGuideBody)
            Text("Imported \(session.progress.uploaded) of \(session.progress.total)")
                .font(.fieldGuideLabel)
            if let reason = session.progress.waitingReason {
                Label(reason, systemImage: "hourglass")
            }
            if let runID = session.runID, session.phase != .complete {
                NavigationLink(runLinkTitle) { runDestination(runID) }
            }
            ProgressView(
                value: Double(session.progress.analyzed), total: Double(max(session.progress.total, 1))
            )
            Text("Analyzed \(session.progress.analyzed) of \(session.progress.total)")
                .font(.fieldGuideLabel)
                .foregroundStyle(FieldGuideTokens.graphiteSecondary)
            if session.progress.excluded > 0 {
                Text("Skipped \(session.progress.excluded) photos")
                    .font(.fieldGuideLabel)
            }
            if !session.progress.failedIDs.isEmpty {
                Label(
                    "\(session.progress.failedIDs.count) photo\(session.progress.failedIDs.count == 1 ? "" : "s") need a retry",
                    systemImage: "exclamationmark.triangle"
                )
                .foregroundStyle(FieldGuideTokens.destructive)
            }
            if !session.failedUploadPhotos.isEmpty {
                ForEach(session.failedUploadPhotos, id: \.id) { photo in
                    HStack {
                        Text(photo.file.filename)
                        Spacer()
                        Button("Retry") { session.retryPhoto(photo.id) }
                            .disabled(session.hasActiveWork || !session.canRetry)
                    }
                }
                Button("Continue without failed photos") { session.continueWithoutFailedUploads() }
                    .disabled(session.hasActiveWork || !session.canRetry)
            }
            if !session.failedAnalysisPhotos.isEmpty {
                VStack(alignment: .leading, spacing: FieldGuideTokens.Space.xs) {
                    ForEach(session.failedAnalysisPhotos, id: \.id) { photo in
                        Label(photo.file.filename, systemImage: "photo")
                            .font(.fieldGuideLabel)
                            .foregroundStyle(FieldGuideTokens.graphiteSecondary)
                    }
                }
                .accessibilityIdentifier("photos.run.failedAnalysis")
            }
            statusAction
        }
        .padding(FieldGuideTokens.Space.md)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .task(id: session.runID) {
            guard let runID = session.runID else { return }
            while !Task.isCancelled {
                await review.refresh(runID: runID, client: appModel.client)
                do { try await Task.sleep(for: .seconds(3)) } catch { return }
            }
        }
    }

    private var stageTitle: String {
        switch session.phase {
        case .complete: "Photos imported"
        case .cancelled: "Remaining work cancelled"
        case .interrupted: "Waiting to continue on this device"
        case .failed: "Upload needs attention"
        case .idle, .running:
            session.progress.uploaded == session.progress.total
                ? "Analyzing photos" : "Uploading photos"
        }
    }

    @ViewBuilder private var statusAction: some View {
        switch session.phase {
        case .idle, .running:
            EmptyView()
        case .complete:
            if let runID = session.runID {
                Label("\(session.progress.uploaded) photos imported", systemImage: "checkmark.circle.fill")
                    .foregroundStyle(FieldGuideTokens.positive)
                if session.progress.analysisPending > 0,
                    session.progress.failedIDs.isEmpty
                {
                    Label("Photo details are still processing on this device.", systemImage: "sparkles")
                        .foregroundStyle(FieldGuideTokens.graphiteSecondary)
                }
                Text("The agent will propose item groups for your review before products are created.")
                    .font(.fieldGuideBody)
                NavigationLink {
                    runDestination(runID)
                } label: {
                    Label(runLinkTitle, systemImage: "square.stack.3d.up")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                if session.canRetryAnalysis {
                    Button("Continue without device details") { session.skipFailedAnalysis() }
                        .buttonStyle(.bordered)
                    Button("Retry photo details") { onRetryAnalysis() }
                        .buttonStyle(.bordered)
                        .accessibilityIdentifier("photos.run.retryAnalysis")
                }
            }
        case .cancelled:
            Text("Uploaded photos remain in the import.")
        case .interrupted:
            Text("This device will continue automatically when the app reopens.")
        case .failed(let message):
            Label(message, systemImage: "exclamationmark.triangle")
                .foregroundStyle(FieldGuideTokens.destructive)
            Button("Retry failed photos") { onRetryUpload() }
                .buttonStyle(.borderedProminent)
                .accessibilityIdentifier("photos.run.retryUpload")
        }
    }
}

#Preview(traits: .modifier(SignedInPreview())) {
    PhotoImportRunSheetPreview()
}

private struct PhotoImportRunSheetPreview: View {
    @State private var flow = PhotoImportRunFlow(client: PreviewFixtures.signedInModel().client)

    var body: some View {
        PhotoImportRunSheet(items: [], flow: flow, onDone: { _ in })
    }
}
