import CubbyKit
import SwiftUI

/// Household Activity uses generic Run and Job lists alongside this device's local work.
struct ActivityView: View {
    @Environment(AppModel.self) private var appModel

    @State private var backlog: DeviceBacklogBanner?
    @State private var backlogError: String?
    @State private var overview: HouseholdQueueOverview?
    @State private var selectedJobs: Set<String> = []

    /// Leases renew every 15 s; reloading at that pace keeps the countdowns and groups current
    /// while Activity is on screen.
    private static let refreshInterval = Duration.seconds(15)

    var body: some View {
        List {
            if let overview, let health = overview.health, !health.alerts.isEmpty {
                Section("Queue unhealthy") {
                    ForEach(Array(health.alerts.enumerated()), id: \.offset) { _, alert in
                        Label(alert.evidence, systemImage: "exclamationmark.triangle")
                            .foregroundStyle(FieldGuideTokens.warning)
                    }
                }
            }
            DeviceBacklogBannerSection(
                backlog: backlog, error: backlogError,
                thisDeviceProcessing: appModel.companionImageActivity.phase == .processing)
            localExecution()
            ImageWorkConcurrencySection()
            if let overview {
                Section {
                    ScrollView(.horizontal) {
                        HStack {
                            ForEach(Array(overview.counts.enumerated()), id: \.offset) { _, chip in
                                Button {
                                    selectedJobs.removeAll()
                                    Task {
                                        await overview.filter(
                                            lane: chip.lane.rawValue, reason: chip.reason.rawValue)
                                    }
                                } label: {
                                    Text(
                                        "\(queueLabel("lane", chip.lane.rawValue)) · \(queueLabel("reason", chip.reason.rawValue)) \(chip.count)"
                                    )
                                }
                                .buttonStyle(.bordered)
                            }
                        }
                    }
                }
                Section("Runs needing attention") {
                    entityRows(
                        overview.runs, key: .run,
                        columns: ["purpose", "status", "waitingOn", "stalled", "startedAt", "chargedCost"])
                    activityDestination(.entityList(.run, savedView: "attention")) {
                        Text("All \(overview.runs.meta?.totalCount ?? 0)")
                    }
                }
                Section("Jobs") {
                    Menu("Job view") {
                        ForEach(EntityCatalog[.job].presentation.savedViews, id: \.id) { view in
                            Button(view.label) {
                                selectedJobs.removeAll()
                                Task { await overview.applyJobView(view) }
                            }
                        }
                    }
                    Button(selectedJobs.isEmpty ? "Retry matching Jobs now" : "Retry selected Jobs now") {
                        Task { await overview.retry(codes: Array(selectedJobs)) }
                    }
                    .disabled(overview.isRetrying)
                    .buttonStyle(.borderless)
                    if let error = overview.error {
                        Text(error.localizedDescription).foregroundStyle(FieldGuideTokens.warning)
                            .task { Diagnostics.report(error, context: "activity.queue") }
                    }
                    ForEach(overview.jobs.rows) { row in
                        HStack(alignment: .top) {
                            Button {
                                if !selectedJobs.insert(row.id).inserted { selectedJobs.remove(row.id) }
                            } label: {
                                Image(
                                    systemName: selectedJobs.contains(row.id)
                                        ? "checkmark.circle.fill" : "circle")
                            }
                            .buttonStyle(.borderless)
                            .accessibilityLabel("Select \(row.id)")
                            DisclosureGroup {
                                ActivityJobExplainPanel(code: row.id, overview: overview)
                            } label: {
                                activityDestination(.entityDetail(.job, id: row.id)) {
                                    EntityRowView(
                                        key: .job, row: row,
                                        columns: [
                                            "kind", "lane", "state", "waitingOn", "runId", "attempts",
                                            "leaseExpiresAt",
                                        ])
                                }
                            }
                        }
                    }
                    listState(overview.jobs)
                    activityDestination(.entityList(.job, filters: overview.jobs.filters)) {
                        Text("All \(overview.jobs.meta?.totalCount ?? 0)")
                    }
                }
            } else {
                ProgressView()
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
            return local + (overview?.runs.rows ?? []).map { .serverRun($0.id) }
                + (overview?.jobs.rows ?? []).map { .record(RecordSelection(key: .job, id: $0.id)) }
        }
    #endif

    private func load() async {
        guard appModel.phase == .signedIn else { return }
        if overview == nil { overview = HouseholdQueueOverview(client: appModel.client) }
        async let backlogLoad = Self.attempt { try await DeviceBacklogBanner.load(client: appModel.client) }
        await overview?.refresh()
        switch await backlogLoad {
        case .success(let value): (backlog, backlogError) = (value, nil)
        case .failure(let error): backlogError = report(error, context: "activity.deviceBacklog")
        }
    }

    private func queueLabel(_ field: String, _ value: String) -> String {
        EntityCatalog[.job].filter(field)?.options?.first { $0.value == value }?.label ?? value
    }

    @ViewBuilder private func entityRows(_ model: GenericEntityListModel, key: EntityKey, columns: [String])
        -> some View
    {
        ForEach(model.rows) { row in
            activityDestination(.entityDetail(key, id: row.id)) {
                EntityRowView(key: key, row: row, columns: columns)
            }
        }
        listState(model)
    }

    @ViewBuilder private func activityDestination<Label: View>(
        _ route: Route, @ViewBuilder label: () -> Label
    ) -> some View {
        #if os(macOS)
            Button {
                if case .entityDetail(let key, let id) = route {
                    appModel.navigator.selectedActivity =
                        key == .run
                        ? .serverRun(id) : .record(RecordSelection(key: key, id: id))
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
        case .record(let record): EntityDetailView(key: record.key, id: record.id).id(record)
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
