import CubbyKit
import Observation
import SwiftUI

@Observable
@MainActor
private final class ActivityListModel {
    enum Execution: Hashable {
        case all
        case thisDevice
        case cloud
        case unknown
        case device(String)
    }

    enum DateRange: String, CaseIterable, Identifiable {
        case all = "Any time"
        case day = "Past 24 hours"
        case week = "Past 7 days"
        case month = "Past 30 days"

        var id: Self { self }

        var start: Date? {
            let days: Int? =
                switch self {
                case .all: nil
                case .day: 1
                case .week: 7
                case .month: 30
                }
            return days.flatMap { Calendar.current.date(byAdding: .day, value: -$0, to: .now) }
        }
    }

    private(set) var runs: [ActivityRun] = []
    private(set) var total = 0
    private(set) var nextCursor: String?
    private(set) var loading = false
    private(set) var devices: [ActivityExecutor] = []
    private var requestGeneration = 0
    var error: String?
    var kind: ActivityKind?
    var state = ""
    var subjectID = ""
    var submissionID = ""
    var execution: Execution = .all
    var dateRange: DateRange = .all

    var filters: CubbyClient.ActivityFilters {
        let executor: CubbyClient.ActivityFilters.Executor =
            switch execution {
            case .all: .all
            case .cloud: .cloud
            case .unknown: .unknown
            case .thisDevice: .device(AppInstallationID.current.uuidString.lowercased())
            case .device(let id): .device(id)
            }
        return .init(
            kind: kind, state: state.nilIfBlank, subjectID: subjectID.nilIfBlank,
            submissionID: submissionID.nilIfBlank, executor: executor, from: dateRange.start)
    }

    var filterIdentity: String {
        "\(kind?.rawValue ?? "all"):\(state):\(subjectID):\(submissionID):\(execution):\(dateRange.rawValue)"
    }

    func load(client: CubbyClient, reset: Bool = true) async {
        guard reset || !loading else { return }
        let requestedFilters = filters
        requestGeneration += 1
        let generation = requestGeneration
        loading = true
        defer { if generation == requestGeneration { loading = false } }
        do {
            let page = try await client.activityRuns(
                filters: requestedFilters, cursor: reset ? nil : nextCursor)
            guard generation == requestGeneration, requestedFilters == filters else { return }
            if reset {
                runs = page.items
            } else {
                let known = Set(runs.map(\.id))
                runs += page.items.filter { !known.contains($0.id) }
            }
            total = page.total
            nextCursor = page.nextCursor
            error = nil
        } catch {
            guard !Task.isCancelled else { return }
            self.error = error.localizedDescription
            Diagnostics.report(error, context: "activity.list")
        }
    }

    func refreshLoaded(client: CubbyClient, context: String = "activity.refresh") async {
        guard !loading else { return }
        let requestedFilters = filters
        let targetCount = max(20, runs.count)
        requestGeneration += 1
        let generation = requestGeneration
        loading = true
        defer { if generation == requestGeneration { loading = false } }
        do {
            var refreshed: [ActivityRun] = []
            var seen: Set<String> = []
            var cursor: String?
            var total = 0
            repeat {
                let page = try await client.activityRuns(
                    filters: requestedFilters, cursor: cursor,
                    limit: min(100, targetCount - refreshed.count))
                total = page.total
                for run in page.items where seen.insert(run.id).inserted {
                    refreshed.append(run)
                    if refreshed.count == targetCount { break }
                }
                guard refreshed.count < targetCount else {
                    cursor = page.nextCursor
                    break
                }
                guard page.nextCursor != cursor else {
                    cursor = nil
                    break
                }
                cursor = page.nextCursor
            } while cursor != nil
            guard generation == requestGeneration, requestedFilters == filters else { return }
            runs = refreshed
            self.total = total
            nextCursor = cursor
            error = nil
        } catch {
            guard !Task.isCancelled, generation == requestGeneration else { return }
            self.error = error.localizedDescription
            Diagnostics.report(error, context: context)
        }
    }

    func loadDevices(client: CubbyClient) async {
        do {
            devices = try await client.activityDevices().items
        } catch {
            Diagnostics.report(error, context: "activity.devices")
        }
    }

    func pollActive(client: CubbyClient) async {
        while !Task.isCancelled {
            if !loading, runs.contains(where: \.active) {
                await refreshLoaded(client: client, context: "activity.poll")
            }
            do {
                try await Task.sleep(for: .seconds(5))
            } catch {
                return
            }
        }
    }
}

struct ActivityView: View {
    @Environment(AppModel.self) private var appModel
    @State private var model = ActivityListModel()

    var body: some View {
        List {
            localExecution
            filters
            Section {
                if let error = model.error {
                    ContentUnavailableView(
                        "Couldn’t load activity", systemImage: "exclamationmark.triangle",
                        description: Text(error))
                } else if model.runs.isEmpty, !model.loading {
                    ContentUnavailableView(
                        "No activity", systemImage: "clock.arrow.trianglehead.counterclockwise.rotate.90")
                }
                ForEach(model.runs, id: \.id) { run in
                    NavigationLink(value: Route.activityDetail(run.id)) {
                        ActivityRunRow(run: run)
                    }
                }
                if model.nextCursor != nil {
                    Button("Load more") {
                        Task { await model.load(client: appModel.client, reset: false) }
                    }
                    .disabled(model.loading)
                }
            } header: {
                Text(model.total == 1 ? "1 run" : "\(model.total) runs")
            }
        }
        .navigationTitle("Activity")
        .refreshable { await model.refreshLoaded(client: appModel.client) }
        .task(id: "\(appModel.host):\(model.filterIdentity)") {
            await model.load(client: appModel.client)
        }
        .task(id: appModel.host) { await model.loadDevices(client: appModel.client) }
        .task(id: "\(appModel.host):\(model.filterIdentity):poll") {
            await model.pollActive(client: appModel.client)
        }
    }

    private var filters: some View {
        Section {
            DisclosureGroup("Filters") {
                Picker("Work type", selection: $model.kind) {
                    Text("All types").tag(nil as ActivityKind?)
                    ForEach(ActivityKind.allCases, id: \.self) { kind in
                        Text(kind.title).tag(kind as ActivityKind?)
                    }
                }
                Picker("Executor", selection: $model.execution) {
                    Text("All executors").tag(ActivityListModel.Execution.all)
                    Text("This device").tag(ActivityListModel.Execution.thisDevice)
                    Text("Cloud").tag(ActivityListModel.Execution.cloud)
                    Text("Unknown").tag(ActivityListModel.Execution.unknown)
                    ForEach(model.devices, id: \.deviceId) { device in
                        if let id = device.deviceId,
                            id != AppInstallationID.current.uuidString.lowercased()
                        {
                            Text(device.name).tag(ActivityListModel.Execution.device(id))
                        }
                    }
                }
                Picker("Date", selection: $model.dateRange) {
                    ForEach(ActivityListModel.DateRange.allCases) { range in
                        Text(range.rawValue).tag(range)
                    }
                }
                TextField("Status", text: $model.state)
                    .autocorrectionDisabled()
                TextField("Subject ID", text: $model.subjectID)
                    .autocorrectionDisabled()
                TextField("Submission ID", text: $model.submissionID)
                    .autocorrectionDisabled()
            }
        }
    }

    @ViewBuilder private var localExecution: some View {
        let activities = appModel.backgroundActivity.visibleActivities
        Section("This device — now") {
            if activities.isEmpty {
                ContentUnavailableView("Nothing running on this device", systemImage: "checkmark.circle")
            } else {
                ForEach(activities) { activity in
                    LocalActivityRow(activity: activity) {
                        appModel.backgroundActivity.cancel(id: activity.id)
                    }
                }
            }
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
            .frame(width: 22)
            VStack(alignment: .leading, spacing: 4) {
                Text(activity.title).font(.headline)
                if let detail = activity.detail {
                    Text(detail).font(.caption).foregroundStyle(.secondary)
                }
                Text(activity.startedAt, style: .relative).font(.caption).foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
            if activity.isCancellable {
                Button("Cancel", role: .destructive, action: onCancel)
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
                    LabeledContent("Started") { Text(activity.startedAt, style: .relative) }
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
                        Button("Cancel", role: .destructive) {
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

private extension String {
    var nilIfBlank: String? {
        let value = trimmingCharacters(in: .whitespacesAndNewlines)
        return value.isEmpty ? nil : value
    }
}

private struct ActivityRunRow: View {
    let run: ActivityRun

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: run.kind.symbol)
                .foregroundStyle(run.active ? PorcelainTokens.cobalt : Color.secondary)
                .frame(width: 22)
            VStack(alignment: .leading, spacing: 4) {
                Text(run.subjectName).font(.headline)
                HStack(spacing: 6) {
                    Text(run.kind.title)
                    Text("·")
                    Text(run.state.replacingOccurrences(of: "_", with: " ").capitalized)
                    Text("·")
                    Text(run.createdAt, style: .relative)
                }
                .font(.caption)
                .foregroundStyle(.secondary)
                if !run.executors.isEmpty {
                    Text(run.executors.map(\.name).joined(separator: ", "))
                        .font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
                if let error = run.error {
                    Text(error).font(.caption).foregroundStyle(PorcelainTokens.destructive).lineLimit(2)
                }
            }
        }
        .padding(.vertical, 4)
    }
}

@Observable
@MainActor
private final class ActivityDetailModel {
    private(set) var detail: ActivityDetailOutput?
    private(set) var events: [ActivityEvent] = []
    private(set) var eventCursor: String?
    private(set) var loading = false
    private var requestGeneration = 0
    var error: String?

    func load(id: String, client: CubbyClient) async {
        guard !loading else { return }
        requestGeneration += 1
        let generation = requestGeneration
        loading = true
        defer { if generation == requestGeneration { loading = false } }
        do {
            async let detail = client.activityDetail(id)
            async let events = client.activityEvents(id)
            let loaded = try await (detail, events)
            guard generation == requestGeneration else { return }
            self.detail = loaded.0
            self.events = loaded.1.items
            eventCursor = loaded.1.nextCursor
            error = nil
        } catch {
            self.error = error.localizedDescription
            Diagnostics.report(error, context: "activity.detail")
        }
    }

    func loadMoreEvents(id: String, client: CubbyClient) async {
        guard let eventCursor, !loading else { return }
        loading = true
        defer { loading = false }
        do {
            let page = try await client.activityEvents(id, cursor: eventCursor)
            events += page.items
            self.eventCursor = page.nextCursor
        } catch {
            self.error = error.localizedDescription
            Diagnostics.report(error, context: "activity.events")
        }
    }

    func loadMoreAttempts(id: String, client: CubbyClient) async {
        guard let cursor = detail?.nextAttemptCursor, !loading else { return }
        loading = true
        defer { loading = false }
        do {
            let page = try await client.activityDetail(id, cursor: cursor)
            guard var current = detail else { return }
            current.attempts += page.attempts
            current.nextAttemptCursor = page.nextAttemptCursor
            detail = current
        } catch {
            self.error = error.localizedDescription
            Diagnostics.report(error, context: "activity.attempts")
        }
    }

    func pollActive(id: String, client: CubbyClient) async {
        while !Task.isCancelled {
            if detail?.run.active == true, !loading {
                await refreshLoaded(id: id, client: client, context: "activity.detailPoll")
            }
            do {
                try await Task.sleep(for: .seconds(5))
            } catch {
                return
            }
        }
    }

    func refreshLoaded(
        id: String, client: CubbyClient, context: String = "activity.detailRefresh"
    ) async {
        guard !loading else { return }
        requestGeneration += 1
        let generation = requestGeneration
        loading = true
        defer { if generation == requestGeneration { loading = false } }
        do {
            let refreshedDetail = try await loadAttemptDepth(
                id: id, count: max(20, detail?.attempts.count ?? 0), client: client)
            let refreshedEvents = try await loadEventDepth(
                id: id, count: max(50, events.count), client: client)
            guard generation == requestGeneration else { return }
            detail = refreshedDetail
            events = refreshedEvents.items
            eventCursor = refreshedEvents.nextCursor
            error = nil
        } catch {
            guard !Task.isCancelled, generation == requestGeneration else { return }
            self.error = error.localizedDescription
            Diagnostics.report(error, context: context)
        }
    }

    private func loadAttemptDepth(
        id: String, count: Int, client: CubbyClient
    ) async throws -> ActivityDetailOutput {
        var cursor: String?
        var result: ActivityDetailOutput?
        var attempts: [ActivityAttempt] = []
        var seen: Set<Int> = []
        repeat {
            let page = try await client.activityDetail(
                id, cursor: cursor, limit: min(100, count - attempts.count))
            if result == nil { result = page }
            for attempt in page.attempts where seen.insert(attempt.number).inserted {
                attempts.append(attempt)
                if attempts.count == count { break }
            }
            guard attempts.count < count else {
                cursor = page.nextAttemptCursor
                break
            }
            guard page.nextAttemptCursor != cursor else {
                cursor = nil
                break
            }
            cursor = page.nextAttemptCursor
        } while cursor != nil
        guard var result else { throw CancellationError() }
        result.attempts = attempts
        result.nextAttemptCursor = cursor
        return result
    }

    private func loadEventDepth(
        id: String, count: Int, client: CubbyClient
    ) async throws -> (items: [ActivityEvent], nextCursor: String?) {
        var cursor: String?
        var events: [ActivityEvent] = []
        var seen: Set<String> = []
        repeat {
            let page = try await client.activityEvents(
                id, cursor: cursor, limit: min(100, count - events.count))
            for event in page.items where seen.insert(event.id).inserted {
                events.append(event)
                if events.count == count { break }
            }
            guard events.count < count else {
                cursor = page.nextCursor
                break
            }
            guard page.nextCursor != cursor else {
                cursor = nil
                break
            }
            cursor = page.nextCursor
        } while cursor != nil
        return (events, cursor)
    }
}

struct ActivityDetailView: View {
    let id: String
    @Environment(AppModel.self) private var appModel
    @State private var model = ActivityDetailModel()

    var body: some View {
        List {
            if let detail = model.detail {
                runSection(detail: detail)
                attemptsSection(detail: detail)
                eventsSection()
            } else if let error = model.error {
                ContentUnavailableView(
                    "Couldn’t load run", systemImage: "exclamationmark.triangle",
                    description: Text(error))
            } else {
                ProgressView("Loading activity…")
            }
        }
        .navigationTitle(model.detail?.run.subjectName ?? "Activity")
        .refreshable { await model.refreshLoaded(id: id, client: appModel.client) }
        #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
        #endif
        .task(id: "\(appModel.host):\(id)") { await model.load(id: id, client: appModel.client) }
        .task(id: "\(appModel.host):\(id):poll") {
            await model.pollActive(id: id, client: appModel.client)
        }
    }

    private func runSection(detail: ActivityDetailOutput) -> some View {
        Section("Run") {
            LabeledContent("Work", value: detail.run.kind.title)
            LabeledContent("Subject", value: detail.run.subjectName)
            LabeledContent("State", value: detail.run.state)
            LabeledContent("Started") { Text(detail.run.createdAt, style: .relative) }
            if let cost = detail.run.estimatedCost {
                LabeledContent("Estimated cost", value: cost, format: .currency(code: "USD"))
            }
            if let error = detail.run.error {
                Text(error).foregroundStyle(PorcelainTokens.destructive)
            }
        }
    }

    private func attemptsSection(detail: ActivityDetailOutput) -> some View {
        Section("Attempts") {
            ForEach(detail.attempts, id: \.number) { attempt in
                DisclosureGroup("Attempt \(attempt.number) · \(attempt.state)") {
                    if let executor = attempt.executor {
                        LabeledContent("Executor", value: executor.name)
                        LabeledContent("Platform", value: executor.platform.rawValue)
                        if let version = executor.appVersion {
                            LabeledContent("App", value: version)
                        }
                        if let version = executor.osVersion {
                            LabeledContent("OS", value: version)
                        }
                    }
                    diagnosticText("Diagnostics", attempt.diagnosticsJson)
                    diagnosticText("Result", attempt.resultJson)
                    if let error = attempt.error {
                        Text(error).foregroundStyle(PorcelainTokens.destructive)
                    }
                }
            }
            if detail.nextAttemptCursor != nil {
                Button("Load more attempts") {
                    Task { await model.loadMoreAttempts(id: id, client: appModel.client) }
                }
            }
        }
    }

    private func eventsSection() -> some View {
        Section("Events") {
            ForEach(model.events, id: \.id) { event in
                VStack(alignment: .leading, spacing: 3) {
                    Text(event.event).font(.body.monospaced())
                    Text(
                        "\(event.source.rawValue) · \(event.occurredAt.formatted(.relative(presentation: .named)))"
                    )
                    .font(.caption).foregroundStyle(.secondary)
                    if let details = event.detailsJson {
                        Text(details).font(.caption.monospaced()).textSelection(.enabled)
                    }
                }
            }
            if model.eventCursor != nil {
                Button("Load more events") {
                    Task { await model.loadMoreEvents(id: id, client: appModel.client) }
                }
            }
        }
    }

    @ViewBuilder private func diagnosticText(_ title: String, _ value: String?) -> some View {
        if let value {
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(.caption).foregroundStyle(.secondary)
                Text(value).font(.caption.monospaced()).textSelection(.enabled)
            }
        }
    }
}

private extension ActivityKind {
    var title: String {
        switch self {
        case .purchaseImport: "Purchase import"
        case .purchaseValidation: "Purchase validation"
        case .productEnrichment: "Product enrichment"
        case .describeImage: "Image description"
        case .subjectLift: "Image cutout"
        }
    }

    var symbol: String {
        switch self {
        case .purchaseImport, .purchaseValidation: "cart"
        case .productEnrichment: "sparkles"
        case .describeImage: "text.below.photo"
        case .subjectLift: "person.crop.rectangle"
        }
    }
}

#Preview(traits: .modifier(SignedInPreview())) {
    NavigationStack { ActivityView() }
}
