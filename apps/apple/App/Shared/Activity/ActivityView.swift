import CubbyKit
import SwiftUI

/// Work shows this device's work, the device backlog, Runs in progress and Runs needing
/// attention, then All changes (the audit history). The household's actionable work across every
/// source is web's `/activity`.
struct ActivityView: View {
    @Environment(AppModel.self) private var appModel

    @State private var backlog: DeviceBacklogBanner?
    @State private var backlogError: String?
    @State private var inProgress: GenericEntityListModel?
    @State private var attention: GenericEntityListModel?

    /// Reloading while Work is on screen keeps the backlog ETA and both Run sections current.
    private static let refreshInterval = Duration.seconds(15)

    var body: some View {
        List {
            DeviceBacklogBannerSection(
                backlog: backlog, error: backlogError,
                thisDeviceProcessing: appModel.companionImageActivity.phase == .processing,
                retry: { await load() })
            localExecution()
            runSection("In progress", phase: "active", model: inProgress)
            runSection("Runs needing attention", phase: "needs", model: attention)
            // Audit history lives here on every platform; household work continues on web.
            Section {
                activityDestination(.auditHistory) {
                    Label("All changes", systemImage: "clock")
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .contentShape(Rectangle())
                }
                .accessibilityIdentifier("activity.changes")
                OpenOnWebButton(target: .route(path: "/activity"), label: "Open Work on web")
            }
        }
        .fieldGuideSectionStyle()
        .navigationTitle("Work")
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
            return local + (inProgress?.rows ?? []).map { .serverRun($0.id) }
                + (attention?.rows ?? []).map { .serverRun($0.id) }
        }
    #endif

    private func load() async {
        guard appModel.phase == .signedIn else { return }
        if inProgress == nil { inProgress = Self.runs(phase: "active", client: appModel.client) }
        if attention == nil { attention = Self.runs(phase: "needs", client: appModel.client) }
        async let backlogLoad = Self.attempt { try await DeviceBacklogBanner.load(client: appModel.client) }
        await inProgress?.refresh()
        await attention?.refresh()
        switch await backlogLoad {
        case .success(let value): (backlog, backlogError) = (value, nil)
        case .failure(let error): backlogError = report(error, context: "activity.deviceBacklog")
        }
    }

    /// The Run list's opening filters narrowed to one phase (Active, Needs you), flat and bounded
    /// to 10.
    private static func phaseFilters(_ phase: String) -> EntityFilterState {
        var filters = EntityFilterState(filters: EntityCatalog[.run].presentation.initialFilters)
        filters.set([phase], for: GenericEntityListModel.phaseGroupingKey)
        return filters
    }

    private static func runs(phase: String, client: CubbyClient) -> GenericEntityListModel {
        GenericEntityListModel(
            descriptor: EntityCatalog[.run], client: client, pageSize: 10, filters: phaseFilters(phase),
            groupDimensions: [], nested: false)
    }

    @ViewBuilder private func runSection(
        _ title: String, phase: String, model: GenericEntityListModel?
    ) -> some View {
        Section(title) {
            if let model {
                ForEach(model.rows) { row in
                    activityDestination(.entityDetail(.run, id: row.id)) {
                        EntityRowView(key: .run, row: row)
                    }
                    .accessibilityIdentifier("activity.run.\(row.id)")
                }
                listState(model)
                // The section shows at most a page; the full saved view opens only when more match.
                if let total = model.meta?.totalCount, total > model.rows.count {
                    activityDestination(.entityList(.run, filters: Self.phaseFilters(phase))) {
                        HStack {
                            Text("Show all")
                            Spacer(minLength: FieldGuideTokens.Space.sm)
                            Text(ValueFormat.count(Double(total)))
                                .monospacedDigit().foregroundStyle(.secondary)
                        }
                        .contentShape(Rectangle())
                    }
                    .accessibilityLabel("Show all \(ValueFormat.count(Double(total))) \(title)")
                }
            } else {
                LoadingIndicator(label: "Loading runs")
            }
        }
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
        case .idle, .loading: LoadingIndicator(label: "Loading runs")
        case .failed(let message):
            InlineLoadFailure(message: message) { await model.refresh() }
        case .unavailable(let message):
            // Not a transient failure: Retry would ask the same unsupported question again.
            Label(message, systemImage: "exclamationmark.triangle")
                .font(.callout).foregroundStyle(FieldGuideTokens.warning)
        case .loaded:
            if model.rows.isEmpty { Text("None right now").font(.callout).foregroundStyle(.secondary) }
            if let error = model.refreshError {
                InlineLoadFailure(message: error) { await model.refresh() }
            }
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
            // A control is a row, never a footer: footers explain.
            Toggle("Automatic work on this device", isOn: automaticWorkBinding)
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
            Text("This device")
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
                // The navigation title already names the task; rows add only what it does not.
                Section {
                    if let detail = activity.detail {
                        LabeledContent("Detail", value: detail)
                    }
                    LabeledContent("Started") {
                        DateDisplay(date: activity.startedAt)
                    }
                    LabeledContent("Progress") {
                        if let progress = activity.progress {
                            HStack(spacing: FieldGuideTokens.Space.sm) {
                                ProgressView(value: progress).frame(maxWidth: 160)
                                Text(progress, format: .percent.precision(.fractionLength(0)))
                                    .monospacedDigit()
                            }
                        } else {
                            ProgressView().controlSize(.small)
                        }
                    }
                }
                if activity.isCancellable {
                    Section {
                        Button("Stop", role: .destructive) {
                            appModel.backgroundActivity.cancel(id: activity.id)
                        }
                    }
                }
            }
        }
        .overlay {
            if activity == nil {
                ContentUnavailableView("Finished", systemImage: "checkmark.circle")
            }
        }
        .fieldGuideSectionStyle()
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
