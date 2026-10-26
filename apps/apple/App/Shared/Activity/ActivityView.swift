import CubbyKit
import SwiftUI

/// Activity shows this device's work, the device backlog and Runs needing attention. The
/// household job queue (lanes, retries, leases) is web's `/work-queue`.
struct ActivityView: View {
    @Environment(AppModel.self) private var appModel

    @State private var backlog: DeviceBacklogBanner?
    @State private var backlogError: String?
    @State private var attention: GenericEntityListModel?

    /// Reloading while Activity is on screen keeps the backlog ETA and attention Runs current.
    private static let refreshInterval = Duration.seconds(15)

    var body: some View {
        List {
            DeviceBacklogBannerSection(
                backlog: backlog, error: backlogError,
                thisDeviceProcessing: appModel.companionImageActivity.phase == .processing)
            localExecution()
            Section("Runs needing attention") {
                if let attention {
                    ForEach(attention.rows) { row in
                        activityDestination(.entityDetail(.run, id: row.id)) {
                            EntityRowView(
                                key: .run, row: row,
                                columns: ["purpose", "status", "waitingOn", "stalled", "startedAt", "chargedCost"])
                        }
                    }
                    listState(attention)
                    activityDestination(.entityList(.run, savedView: "attention")) {
                        Text("All \(attention.meta?.totalCount ?? 0)")
                    }
                } else {
                    ProgressView()
                }
            }
            Section {
                OpenOnWebButton(target: .route(path: "/work-queue"), label: "Open work queue on web")
            }
        }
        .navigationTitle("Activity")
        .refreshControl { await load() }
        // Reload when this device's own phase changes (a job finished, a reconnect).
        .task(id: appModel.companionImageActivity.phase) { await load() }
        .task {
            while !Task.isCancelled {
                do { try await Task.sleep(for: Self.refreshInterval) } catch { return }
                await load()
            }
        }
        #if os(macOS)
            .onChange(of: initialSelections, initial: true) { _, selections in
                if appModel.navigator.selectedActivity == nil {
                    appModel.navigator.selectedActivity = selections.first
                }
            }
        #else
            .inspector(
                isPresented: Binding(
                    get: { appModel.navigator.selectedActivity != nil },
                    set: { if !$0 { appModel.navigator.selectedActivity = nil } }
                )
            ) {
                if let selection = appModel.navigator.selectedActivity {
                    ActivitySelectionDetailView(selection: selection)
                    .inspectorColumnWidth(min: 300, ideal: 380, max: 540)
                }
            }
        #endif
    }

    #if os(macOS)
        private var initialSelections: [ActivitySelection] {
            let local = appModel.backgroundActivity.visibleActivities.map { activity in
                if case .serverRun(let id) = activity.link { return ActivitySelection.serverRun(id) }
                return ActivitySelection.localActivity(activity.id)
            }
            return local + (attention?.rows ?? []).map { .serverRun($0.id) }
        }
    #endif

    private func load() async {
        guard appModel.phase == .signedIn else { return }
        if attention == nil { attention = Self.attentionRuns(client: appModel.client) }
        async let backlogLoad = Self.attempt { try await DeviceBacklogBanner.load(client: appModel.client) }
        await attention?.refresh()
        switch await backlogLoad {
        case .success(let value): (backlog, backlogError) = (value, nil)
        case .failure(let error): backlogError = report(error, context: "activity.deviceBacklog")
        }
    }

    /// The Run manifest's `attention` saved view (it excludes system AI passes), bounded to 10.
    private static func attentionRuns(client: CubbyClient) -> GenericEntityListModel {
        let run = EntityCatalog[.run]
        let view = run.presentation.savedViews.first { $0.id == "attention" }
        return GenericEntityListModel(
            descriptor: run, client: client, pageSize: 10,
            sort: view?.sortParameter, filters: view?.filterState ?? EntityFilterState())
    }

    @ViewBuilder private func activityDestination<Label: View>(
        _ route: Route, @ViewBuilder label: () -> Label
    ) -> some View {
        #if os(macOS)
            Button {
                if case .entityDetail(.run, let id) = route {
                    appModel.navigator.selectedActivity = .serverRun(id)
                    appModel.navigator.paths[.activity] = []
                } else {
                    appModel.navigator.paths[.activity, default: []].append(route)
                }
            } label: {
                label()
            }
            .buttonStyle(.plain)
        #else
            NavigationLink(value: route, label: label)
        #endif
    }

    @ViewBuilder private func listState(_ model: GenericEntityListModel) -> some View {
        switch model.phase {
        case .idle, .loading: ProgressView()
        case .failed(let message), .unavailable(let message):
            Text(message).foregroundStyle(FieldGuideTokens.warning)
        case .loaded:
            if model.rows.isEmpty { Text("No matching records").foregroundStyle(.secondary) }
            if let error = model.refreshError { Text(error).foregroundStyle(FieldGuideTokens.warning) }
        }
    }

    private func report(_ error: any Error, context: String) -> String? {
        if error is CancellationError { return nil }
        Diagnostics.report(error, context: context)
        return error.localizedDescription
    }

    private static func attempt<T: Sendable>(
        _ operation: @Sendable () async throws -> T
    ) async -> Result<T, any Error> {
        do { return .success(try await operation()) } catch { return .failure(error) }
    }

    @ViewBuilder private func localExecution() -> some View {
        let activities = appModel.backgroundActivity.visibleActivities
        Section {
            CompanionWorkerStatusRow(activity: appModel.companionImageActivity)
            if !activities.isEmpty {
                ForEach(activities) { activity in
                    let row = LocalActivityRow(activity: activity) {
                        appModel.backgroundActivity.cancel(id: activity.id)
                    }
                    if case .serverRun(let runID) = activity.link {
                        Button {
                            appModel.navigator.selectedActivity = .serverRun(runID)
                            #if os(macOS)
                                appModel.navigator.paths[.activity] = []
                            #endif
                        } label: {
                            row
                        }
                        .buttonStyle(.plain)
                    } else {
                        row
                    }
                }
            }
        } header: {
            Text("This device — now")
        } footer: {
            Toggle("Automatic work on this device", isOn: automaticWorkBinding)
        }
    }

    private var automaticWorkBinding: Binding<Bool> {
        Binding(
            get: { appModel.participation.automaticWork },
            set: { appModel.setParticipation(automaticWork: $0) })
    }
}

struct ActivitySelectionDetailView: View {
    let selection: ActivitySelection

    var body: some View {
        switch selection {
        // A server record is a Run or an Image job; each opens its own generic detail.
        case .serverRun(let id) where id.hasPrefix("IPR-"):
            EntityDetailView(key: .imageJob, id: id).id("imageJob/\(id)")
        case .serverRun(let id): RunConsoleView(runID: id).id(id)
        case .localActivity(let id): LocalActivityDetailView(id: id)
        }
    }
}

private struct LocalActivityRow: View {
    let activity: BackgroundActivity
    let onCancel: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Group {
                if let progress = activity.progress {
                    ProgressView(value: progress)
                } else {
                    ProgressView()
                }
            }
            .fieldGuideIconSlot(width: 22)
            VStack(alignment: .leading, spacing: 4) {
                Text(activity.title).font(.headline)
                if let detail = activity.detail {
                    Text(detail).font(.caption).foregroundStyle(.secondary)
                }
                DateDisplay(date: activity.startedAt).font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
            if activity.isCancellable {
                Button("Stop", role: .destructive, action: onCancel)
                    .buttonStyle(.borderless)
            }
        }
        .padding(.vertical, 4)
    }
}

/// A device-local `BackgroundActivity`'s own detail, reached from `Route.localActivity` (the
/// bar/sidebar-row tap target, or a resumed local-activity link). Reads the activity fresh by id
/// on every access — once the id is no longer among `BackgroundActivityCenter.activities`, the
/// work is done and the screen shows "Finished" rather than a distinct terminal state.
struct LocalActivityDetailView: View {
    let id: String
    @Environment(AppModel.self) private var appModel

    private var activity: BackgroundActivity? {
        appModel.backgroundActivity.activities.first { $0.id == id }
    }

    var body: some View {
        List {
            if let activity {
                Section {
                    LabeledContent("Task", value: activity.title)
                    if let detail = activity.detail {
                        LabeledContent("Detail", value: detail)
                    }
                    LabeledContent("Started") {
                        DateDisplay(date: activity.startedAt)
                    }
                    if let progress = activity.progress {
                        LabeledContent("Progress") {
                            Text(progress, format: .percent.precision(.fractionLength(0)))
                        }
                        ProgressView(value: progress)
                    } else {
                        ProgressView()
                    }
                }
                if activity.isCancellable {
                    Section {
                        Button("Stop", role: .destructive) {
                            appModel.backgroundActivity.cancel(id: activity.id)
                        }
                    }
                }
            } else {
                ContentUnavailableView("Finished", systemImage: "checkmark.circle")
            }
        }
        .navigationTitle(activity?.title ?? "Activity")
        #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
        #endif
    }
}

/// Kept outside the `#Preview` macro bodies below: seeding the model inline there made the type
/// checker choke ("failed to produce diagnostic for expression").
private func previewModelWithRunningLocalActivity() -> AppModel {
    let model = PreviewFixtures.signedInModel()
    _ = model.backgroundActivity.begin(
        BackgroundActivity(
            id: "photo-library-scan", kind: .libraryScan, title: "Scanning library",
            phase: .running, progress: 0.41, detail: "41 of 100", startedAt: .now,
            link: .localActivity("photo-library-scan"), isUserInitiated: false, isCancellable: false))
    return model
}

#Preview("Local activity — running") {
    NavigationStack { LocalActivityDetailView(id: "photo-library-scan") }
        .environment(previewModelWithRunningLocalActivity())
}

#Preview("Local activity — finished", traits: .modifier(SignedInPreview())) {
    NavigationStack { LocalActivityDetailView(id: "gone") }
}

func imageSkipReasonText(_ reason: String) -> String {
    switch reason {
    case "no_subject": "Apple found no foreground subject."
    case "unsupported_format": "This image format is unsupported for the operation."
    case "not_suitable":
        "The image was already transparent, or a previous eligibility policy skipped subject lift."
    case "Image is attached only as label evidence":
        "The previous label-only policy skipped subject lift. Queue missing processing to retry."
    default: reason
    }
}
