import CubbyKit
import Observation
import SwiftUI

@Observable
@MainActor
final class ActivityListModel {
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

    private(set) var children: [String: ActivityListOutput] = [:]
    private(set) var childLoading: [String: Int] = [:]
    private(set) var childErrors: [String: String] = [:]
    var expandedRoots: Set<String> = []
    private(set) var groups: ActivityGroupsOutput?
    var runs: [ActivityRun] { groups?.items.map(\.root) ?? [] }
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
        if reset {
            requestGeneration += 1
            childLoading.removeAll()
            children.removeAll()
            childErrors.removeAll()
            expandedRoots.removeAll()
        }
        let generation = requestGeneration
        loading = true
        defer { if generation == requestGeneration { loading = false } }
        do {
            var page = try await client.activityGroups(
                filters: requestedFilters, cursor: reset ? nil : nextCursor)
            guard generation == requestGeneration, requestedFilters == filters else { return }
            if !reset {
                let known = Set(runs.map(\.id))
                page.items = (groups?.items ?? []) + page.items.filter { !known.contains($0.root.id) }
            }
            groups = page
            total = page.total
            nextCursor = page.nextCursor
            error = nil
        } catch {
            guard !Task.isCancelled, generation == requestGeneration, requestedFilters == filters else {
                return
            }
            self.error = error.localizedDescription
            Diagnostics.report(error, context: "activity.list")
        }
    }

    func refreshLoaded(client: CubbyClient, context: String = "activity.refresh") async {
        guard !loading else { return }
        let requestedFilters = filters
        let targetCount = max(20, runs.count)
        requestGeneration += 1
        childLoading.removeAll()
        let generation = requestGeneration
        loading = true
        defer { if generation == requestGeneration { loading = false } }
        do {
            var refreshed = groups?.items ?? []
            refreshed.removeAll()
            var lastPage: ActivityGroupsOutput?
            var seen: Set<String> = []
            var cursor: String?
            var total = 0
            repeat {
                let page = try await client.activityGroups(
                    filters: requestedFilters, cursor: cursor,
                    limit: min(100, targetCount - refreshed.count))
                total = page.total
                lastPage = page
                for run in page.items where seen.insert(run.root.id).inserted {
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
            lastPage?.items = refreshed
            groups = lastPage
            self.total = total
            nextCursor = cursor
            error = nil
            for rootID in expandedRoots where runs.contains(where: { $0.id == rootID }) {
                await loadChildren(rootID: rootID, client: client, preserveLoaded: true)
            }
        } catch {
            guard !Task.isCancelled, generation == requestGeneration else { return }
            self.error = error.localizedDescription
            Diagnostics.report(error, context: context)
        }
    }

    func loadChildren(
        rootID: String, client: CubbyClient, reset: Bool = true, preserveLoaded: Bool = true
    ) async {
        let generation = requestGeneration
        guard childLoading[rootID] != generation, runs.contains(where: { $0.id == rootID }) else { return }
        let requestedFilters = filters
        let existing = children[rootID]
        guard reset || existing?.nextCursor != nil else { return }
        childLoading[rootID] = generation
        defer { if childLoading[rootID] == generation { childLoading[rootID] = nil } }
        do {
            var rows: [ActivityRun] = reset ? [] : (existing?.items ?? [])
            var seen = Set(rows.map(\.id))
            var cursor = reset ? nil : existing?.nextCursor
            let desired = max(20, existing?.items.count ?? 0)
            var lastPage: ActivityListOutput?
            repeat {
                let page = try await client.activityGroupChildren(
                    rootID: rootID, filters: requestedFilters, cursor: cursor)
                lastPage = page
                rows += page.items.filter { seen.insert($0.id).inserted }
                let previous = cursor
                cursor = page.nextCursor
                if cursor != nil, cursor == previous {
                    lastPage?.nextCursor = nil
                    break
                }
                if !reset || existing == nil || !preserveLoaded || rows.count >= desired { break }
            } while cursor != nil
            guard generation == requestGeneration, requestedFilters == filters else { return }
            lastPage?.items = rows
            children[rootID] = lastPage
            childErrors[rootID] = nil
        } catch {
            guard !Task.isCancelled, generation == requestGeneration, requestedFilters == filters else {
                return
            }
            childErrors[rootID] = error.localizedDescription
            Diagnostics.report(error, context: "activity.groupChildren")
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
            if !loading,
                groups?.items.contains(where: { group in
                    group.active
                        || (group.childCount > 0 && expandedRoots.contains(group.root.id)
                            && children[group.root.id]?.items.contains(where: \.active) == true)
                }) == true
            {
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
                    LoadFailureView(title: "Couldn’t load activity", message: error) {
                        await model.load(client: appModel.client)
                    }
                } else if model.runs.isEmpty, !model.loading {
                    ContentUnavailableView(
                        "No activity", systemImage: "clock.arrow.trianglehead.counterclockwise.rotate.90")
                }
                ForEach(model.groups?.items ?? [], id: \.root.id) { group in
                    if group.childCount > 0 {
                        DisclosureGroup(
                            isExpanded: Binding(
                                get: { model.expandedRoots.contains(group.root.id) },
                                set: { expanded in
                                    if expanded {
                                        model.expandedRoots.insert(group.root.id)
                                        Task {
                                            await model.loadChildren(
                                                rootID: group.root.id, client: appModel.client)
                                        }
                                    } else {
                                        model.expandedRoots.remove(group.root.id)
                                    }
                                }
                            )
                        ) {
                            if let error = model.childErrors[group.root.id] {
                                LoadFailureView(title: "Couldn’t load related work", message: error) {
                                    await model.loadChildren(rootID: group.root.id, client: appModel.client)
                                }
                            }
                            ForEach(model.children[group.root.id]?.items ?? [], id: \.id) { child in
                                runButton(child)
                            }
                            if model.childLoading[group.root.id] != nil {
                                ProgressView("Loading related work")
                            } else if model.children[group.root.id]?.nextCursor != nil {
                                Button("Load more related work") {
                                    Task {
                                        await model.loadChildren(
                                            rootID: group.root.id, client: appModel.client, reset: false)
                                    }
                                }
                            }
                        } label: {
                            VStack(alignment: .leading) {
                                runButton(group.root)
                                Text(group.workSummary)
                                    .font(.caption).foregroundStyle(.secondary)
                                if group.contextOnly {
                                    Text("Parent shown for context; related work matches the filters")
                                        .font(.caption).foregroundStyle(.secondary)
                                }
                                Text("\(group.childCount) related work records")
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                        }
                        .accessibilityIdentifier("activity.group.\(group.root.id)")
                    } else {
                        runButton(group.root)
                    }
                }
                if model.nextCursor != nil {
                    Button("Load more") {
                        Task { await model.load(client: appModel.client, reset: false) }
                    }
                    .disabled(model.loading)
                }
            } header: {
                Text(model.total == 1 ? "1 work group" : "\(model.total) work groups")
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

    private func runButton(_ run: ActivityRun) -> some View {
        Button {
            appModel.navigator.selectedActivity = .serverRun(run.id)
        } label: {
            ActivityRunRow(run: run)
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("activity.run.\(run.id)")
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
        Section {
            if activities.isEmpty {
                ContentUnavailableView(
                    "No device-local work reported", systemImage: "checkmark.circle")
            } else {
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
        case .serverRun(let id): ActivityDetailView(id: id)
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
            Image(systemName: EntityCatalog[run.iconEntity].sfSymbol)
                .foregroundStyle(run.active ? FieldGuideTokens.interaction : Color.secondary)
                .frame(width: 22)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                Text(run.subjectName).font(.headline)
                if run.recordType == .run {
                    EntityQualityFact(key: .run, id: run.id, raw: (try? JSONValue(encoding: run)) ?? .null)
                } else {
                    Text("Not assessed").font(.caption).foregroundStyle(.secondary)
                }
                HStack(spacing: 6) {
                    Text(run.workLabel)
                    Text("·")
                    Text(run.state.replacingOccurrences(of: "_", with: " ").capitalized)
                    Text("·")
                    Text(run.createdAt, style: .relative)
                }
                .font(.caption)
                .foregroundStyle(.secondary)
                if let progress = run.progressLine {
                    Text(progress).font(.caption).monospacedDigit().lineLimit(1)
                }
                if !run.executors.isEmpty {
                    Text(run.executors.map(\.name).joined(separator: ", "))
                        .font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
                if let error = run.error {
                    Text(error).font(.caption).foregroundStyle(FieldGuideTokens.destructive).lineLimit(2)
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
            async let detail = client.activityDetail(.init(id: id, limit: 20))
            async let events = client.activityEvents(.init(id: id, limit: 50))
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
            let page = try await client.activityEvents(.init(id: id, cursor: eventCursor, limit: 50))
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
            let page = try await client.activityDetail(.init(id: id, cursor: cursor, limit: 20))
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
                .init(id: id, cursor: cursor, limit: min(100, count - attempts.count)))
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
                .init(id: id, cursor: cursor, limit: min(100, count - events.count)))
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
                LoadFailureView(title: "Couldn’t load run", message: error) {
                    await model.load(id: id, client: appModel.client)
                }
            } else {
                LoadingIndicator(label: "Loading activity")
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
            if detail.run.kind == .photoInventory {
                Button {
                    appModel.navigator.openPhotoReview(runID: detail.run.id)
                } label: {
                    Label("Review photos and proposed items", systemImage: "photo.on.rectangle")
                }
                .font(.headline)
            }
            LabeledContent("Work", value: detail.run.workLabel)
            LabeledContent("Subject", value: detail.run.subjectName)
            if let step = detail.run.currentStep {
                LabeledContent(detail.run.active ? "Now" : "Last step", value: step)
            }
            if let targets = detail.run.targetSummary {
                LabeledContent("Targets", value: targets)
            }
            if detail.run.recordType == .run {
                LabeledContent("Changed", value: "\(detail.run.changedCount) records")
            }
            LabeledContent(
                "State", value: detail.run.state.replacingOccurrences(of: "_", with: " ").capitalized)
            LabeledContent("Started") { Text(detail.run.createdAt, style: .relative) }
            if let cost = detail.run.estimatedCost {
                LabeledContent("Estimated cost", value: cost, format: .usd)
            }
            if let error = detail.run.error {
                Text(error).foregroundStyle(FieldGuideTokens.destructive)
            }
        }
    }

    private func attemptsSection(detail: ActivityDetailOutput) -> some View {
        Section {
            DisclosureGroup("Attempts · \(detail.attempts.count)") {
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
                            Text(error).foregroundStyle(FieldGuideTokens.destructive)
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
    }

    private func eventsSection() -> some View {
        Section {
            DisclosureGroup("Events · \(model.events.count)") {
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

#Preview(traits: .modifier(SignedInPreview())) {
    NavigationStack { ActivityView() }
}

extension ActivityRun {
    /// Target outcomes, then what an active run is doing now.
    fileprivate var progressLine: String? {
        let step = active ? currentStep : nil
        let parts = [targetSummary, step].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
}
