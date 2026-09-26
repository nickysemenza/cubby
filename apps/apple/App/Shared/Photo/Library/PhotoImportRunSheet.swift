import CubbyKit
import SwiftUI

/// The state behind the bulk "Add to import run" flow: pick or start a `photo_inventory` run,
/// materialize the selection, then hand it to `PhotoImportRunSession`. There is no per-photo
/// destination step — `preparedPhotos` goes into the run in picker order and that is the entire
/// decision the user makes here, matching the "select 1-1000 photos and that's it" requirement
/// this flow exists for (the manifest-based `PhotoImportManifest` owns per-photo routing).
@MainActor
@Observable
final class PhotoImportRunFlow {
    enum Step: Equatable {
        case choosingRun
        case preparing(completed: Int, total: Int)
        case running
    }

    private(set) var step: Step = .choosingRun
    private(set) var openRuns: [EntityRow] = []
    private(set) var loadingRuns = false
    private(set) var prepareError: String?

    var notes = ""
    var selectedOwnerID: LedgerPartyShortcode?
    var selectedOwnerName: String?

    let session: PhotoImportRunSession
    private var preparedPhotos: [PhotoImportRunPhoto] = []
    private var flowTask: Task<Void, Never>?
    private let activityID = "photo-run-upload-\(UUID().uuidString)"
    private var startedAt: Date?

    init(client: CubbyClient, activityCenter: BackgroundActivityCenter? = nil) {
        session = PhotoImportRunSession(uploader: PhotoImportRunUploader(client: client))
        activityCenter?.register(self)
    }

    var isBusy: Bool {
        if case .preparing = step { return true }
        return step == .running && session.isRunning
    }

    /// Best-effort: an empty or failed list still leaves "start a new run" available.
    func loadOpenRuns(client: CubbyClient) async {
        loadingRuns = true
        defer { loadingRuns = false }
        var filters = EntityFilterState()
        filters.set(.many(["running"]), for: "status")
        filters.set(.many(["photo_inventory"]), for: "purpose")
        openRuns =
            (try? await client.list(EntityCatalog[.run], pageSize: 50, filters: filters))?
            .items ?? []
    }

    func startNewRun(items: [PhotoSelectionItem], client: CubbyClient) {
        begin(items: items) { [self] in
            session.start(
                preparedPhotos,
                createRun: PhotoImportCreateRunInput(
                    ledgerPartyId: selectedOwnerID, notes: notes.isEmpty ? nil : notes))
        }
    }

    func useExistingRun(_ id: RunShortcode, items: [PhotoSelectionItem]) {
        begin(items: items) { [self] in session.start(preparedPhotos, runID: id) }
    }

    /// After the session stopped incomplete (`Stop` mid-run, or a chunk that threw): resumes with
    /// the same prepared photos. The actor's own per-photo state means an already-finalized photo
    /// is not resent, so this is a plain retry, not a fresh selection.
    func resume() {
        guard !preparedPhotos.isEmpty, flowTask == nil else { return }
        step = .running
        session.start(preparedPhotos)
    }

    /// Stops whichever phase is in flight: the materialize loop below checks `Task.isCancelled`
    /// per photo, and `PhotoImportRunSession.cancel()` stops further upload chunks (already
    /// finalized ones stay finalized — the server has them).
    func cancel() {
        flowTask?.cancel()
        session.cancel()
    }

    private func begin(items: [PhotoSelectionItem], start: @escaping () -> Void) {
        guard flowTask == nil else { return }
        startedAt = .now
        step = .preparing(completed: 0, total: items.count)
        prepareError = nil
        flowTask = Task { [self] in
            var prepared: [PhotoImportRunPhoto] = []
            for (index, item) in items.enumerated() {
                if Task.isCancelled {
                    step = .choosingRun
                    flowTask = nil
                    return
                }
                do {
                    let file = try await item.materialize()
                    prepared.append(
                        PhotoImportRunPhoto(
                            id: item.id, file: file,
                            provenance: PhotoAnalysisProvenance(
                                source: item.provenanceSource, localIdentifier: item.localIdentifier,
                                filename: file.filename)))
                    step = .preparing(completed: index + 1, total: items.count)
                } catch {
                    prepareError = error.localizedDescription
                    step = .choosingRun
                    flowTask = nil
                    return
                }
            }
            preparedPhotos = prepared
            step = .running
            start()
            flowTask = nil
        }
    }
}

extension PhotoImportRunFlow: BackgroundActivitySource {
    var currentActivities: [BackgroundActivity] {
        let progress: Double?
        let detail: String
        switch step {
        case .choosingRun:
            return []
        case .preparing(let completed, let total):
            progress = total > 0 ? 0.2 * Double(completed) / Double(total) : nil
            detail = "Preparing \(completed) of \(total)"
        case .running:
            guard session.isRunning else { return [] }
            let state = session.progress
            progress =
                state.total > 0
                ? 0.2 + 0.8 * Double(state.uploaded + state.analyzed) / Double(2 * state.total)
                : nil
            detail = "Uploaded \(state.uploaded), analysed \(state.analyzed) of \(state.total)"
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
        .interactiveDismissDisabled(flow.isBusy)
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
        case .running:
            RunningView(session: flow.session, onResume: flow.resume, onDone: finish)
        }
    }

    private var choosingRunView: some View {
        List {
            if let error = flow.prepareError {
                Section {
                    Label(error, systemImage: "exclamationmark.triangle")
                        .foregroundStyle(PorcelainTokens.destructive)
                }
            }
            Section {
                Button {
                    pickingOwner = true
                } label: {
                    LabeledContent("Owner", value: flow.selectedOwnerName ?? "You (signed-in member)")
                }
                .accessibilityIdentifier("photos.run.owner")
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
        VStack(spacing: PorcelainTokens.Space.md) {
            ProgressView(value: Double(completed), total: Double(max(total, 1)))
            Text("Preparing \(completed) of \(total)…")
                .font(.porcelainBody)
                .foregroundStyle(PorcelainTokens.graphiteSecondary)
        }
        .padding()
    }

    @ToolbarContentBuilder private var toolbar: some ToolbarContent {
        ToolbarItem(placement: .cancellationAction) {
            Button(flow.isBusy ? "Stop" : "Cancel") {
                if flow.isBusy {
                    flow.cancel()
                } else {
                    dismiss()
                }
            }
            .accessibilityIdentifier("photos.run.stop")
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
    let onResume: () -> Void
    let onDone: (RunShortcode) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: PorcelainTokens.Space.md) {
            Text(stageTitle)
                .font(.headline)
            ProgressView(
                value: Double(session.progress.uploaded), total: Double(max(session.progress.total, 1))
            )
            Text("Uploaded \(session.progress.uploaded) of \(session.progress.total)")
                .font(.porcelainBody)
            ProgressView(
                value: Double(session.progress.analyzed), total: Double(max(session.progress.total, 1))
            )
            Text("Analyzed \(session.progress.analyzed) of \(session.progress.total)")
                .font(.porcelainLabel)
                .foregroundStyle(PorcelainTokens.graphiteSecondary)
            if !session.progress.failedIDs.isEmpty {
                Label(
                    "\(session.progress.failedIDs.count) photo\(session.progress.failedIDs.count == 1 ? "" : "s") need a retry",
                    systemImage: "exclamationmark.triangle"
                )
                .foregroundStyle(PorcelainTokens.destructive)
            }
            statusAction
        }
        .padding()
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private var stageTitle: String {
        switch session.phase {
        case .complete: "Photos uploaded"
        case .cancelled: "Upload paused"
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
                Label("Photos uploaded", systemImage: "checkmark.circle.fill")
                    .foregroundStyle(PorcelainTokens.positive)
                if session.progress.analyzed < session.progress.total,
                    session.progress.failedIDs.isEmpty
                {
                    Label("Photo details are still processing on this device.", systemImage: "sparkles")
                        .foregroundStyle(PorcelainTokens.graphiteSecondary)
                }
                Text("The agent will propose item groups for your review before products are created.")
                    .font(.porcelainBody)
                NavigationLink {
                    RunReviewView(runID: runID)
                } label: {
                    Label("Review item groups", systemImage: "square.stack.3d.up")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                Button("Done") { onDone(runID) }
                    .buttonStyle(.bordered)
                    .accessibilityIdentifier("photos.run.done")
                if session.canRetryAnalysis {
                    Button("Retry photo details") { onResume() }
                        .buttonStyle(.bordered)
                        .accessibilityIdentifier("photos.run.retryAnalysis")
                }
            }
        case .cancelled:
            Button("Resume") { onResume() }
                .buttonStyle(.borderedProminent)
                .accessibilityIdentifier("photos.run.resume")
        case .failed(let message):
            Label(message, systemImage: "exclamationmark.triangle")
                .foregroundStyle(PorcelainTokens.destructive)
            Button("Resume") { onResume() }
                .buttonStyle(.borderedProminent)
                .accessibilityIdentifier("photos.run.resume")
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
