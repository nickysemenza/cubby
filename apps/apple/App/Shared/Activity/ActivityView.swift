import CubbyKit
import SwiftUI

/// Activity: what this device is doing now, and the way into the household's Runs and Image
/// jobs. Server work lists through the generic Run and Image job lists; only device-local
/// progress (with Stop) and the automatic-work switch are this screen's own.
struct ActivityView: View {
    @Environment(AppModel.self) private var appModel

    @State private var queue: HouseholdQueueOverview?
    @State private var queueError: String?
    @State private var backlog: DeviceBacklogBanner?
    @State private var backlogError: String?
    @State private var devices = HouseholdDevices(names: [:], thisDevice: nil)
    @State private var deviceError: String?
    /// The imageJob `processing` saved view (live leases), grouped by `leaseDeviceId`.
    @State private var processingList: GenericEntityListModel?

    /// Leases renew every 15 s; reloading at that pace keeps the countdowns and groups current
    /// while Activity is on screen.
    private static let refreshInterval = Duration.seconds(15)

    private var processing: ProcessingImageJobs {
        ProcessingImageJobs(rows: processingList?.rows ?? [], devices: devices)
    }

    var body: some View {
        let processing = processing
        List {
            DeviceBacklogBannerSection(
                backlog: backlog, error: backlogError,
                thisDeviceProcessing: appModel.companionImageActivity.phase == .processing)
            localExecution(processing.thisDevice)
            OtherDevicesSection(
                processing: processing, expiredLeaseHolders: queue?.expiredLeaseHolders ?? [],
                error: [processingError, deviceError].compactMap { $0 }.first,
                unloadedCount: max(0, (processingList?.meta?.totalCount ?? 0) - processing.loadedCount))
            HouseholdQueueSections(queue: queue, error: queueError)
            Section("Household work") {
                NavigationLink(value: Route.entityList(.run)) {
                    Label("Runs", systemImage: "arrow.triangle.2.circlepath")
                }
                RunsNeedingAttentionRows(queue: queue)
                NavigationLink(value: Route.entityList(.imageJob)) {
                    Label("Image jobs", systemImage: "photo.badge.checkmark")
                }
                NavigationLink(value: Route.entityList(.imageJob, savedView: "attention")) {
                    Label("Image jobs needing attention", systemImage: "exclamationmark.circle")
                }
            }
        }
        .navigationTitle("Activity")
        .refreshable { await load() }
        // Reload when this device's own phase changes (a job finished, a reconnect).
        .task(id: appModel.companionImageActivity.phase) { await load() }
        .task {
            while !Task.isCancelled {
                do { try await Task.sleep(for: Self.refreshInterval) } catch { return }
                await load()
            }
        }
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
    }

    /// A failed refresh keeps the last rows, so it must say so beside them.
    private var processingError: String? {
        guard let processingList else { return nil }
        switch processingList.phase {
        case .failed(let message), .unavailable(let message): return message
        default: return processingList.refreshError ?? processingList.enrichment.errors.first
        }
    }

    /// The queue counts, the device backlog, the Device directory and the processing rows load
    /// side by side; each keeps its last value and reports its own failure.
    private func load() async {
        guard appModel.phase == .signedIn else { return }
        let client = appModel.client
        async let queueLoad = Self.attempt { try await HouseholdQueueOverview.load(client: client) }
        async let backlogLoad = Self.attempt { try await DeviceBacklogBanner.load(client: client) }
        async let devicesLoad = Self.attempt {
            try await HouseholdDevices.load(client: client, installationID: AppInstallationID.current)
        }
        await loadProcessing(client: client)
        switch await queueLoad {
        case .success(let value): (queue, queueError) = (value, nil)
        case .failure(let error): queueError = report(error, context: "activity.householdQueue")
        }
        switch await backlogLoad {
        case .success(let value): (backlog, backlogError) = (value, nil)
        case .failure(let error): backlogError = report(error, context: "activity.deviceBacklog")
        }
        switch await devicesLoad {
        case .success(let value): (devices, deviceError) = (value, nil)
        case .failure(let error): deviceError = report(error, context: "activity.devices")
        }
    }

    private func loadProcessing(client: CubbyClient) async {
        if let processingList {
            await processingList.refresh()
            return
        }
        let descriptor = EntityCatalog[.imageJob]
        let view = descriptor.presentation.savedViews.first { $0.id == "processing" }
        let list = GenericEntityListModel(
            descriptor: descriptor, client: client, pageSize: 50,
            filters: view?.filterState ?? EntityFilterState())
        processingList = list
        await list.loadInitial()
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

    @ViewBuilder private func localExecution(_ thisDevice: [EntityRow]) -> some View {
        let activities = appModel.backgroundActivity.visibleActivities
        Section {
            CompanionWorkerStatusRow(activity: appModel.companionImageActivity)
            ForEach(thisDevice) { row in ProcessingImageJobRow(row: row) }
            if !activities.isEmpty {
                ForEach(activities) { activity in
                    let row = LocalActivityRow(activity: activity) {
                        appModel.backgroundActivity.cancel(id: activity.id)
                    }
                    if case .serverRun(let runID) = activity.link {
                        Button {
                            appModel.navigator.selectedActivity = .serverRun(runID)
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
