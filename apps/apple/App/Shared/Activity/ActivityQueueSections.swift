import CubbyKit
import SwiftUI

/// How Activity words the companion worker's phase. Every phase has its own sentence, so a quiet
/// device always says why it is quiet.
extension CompanionImageWorkerActivity {
    var statusTitle: String {
        if remotePaused, phase == .idle || phase == .pulling { return "Paused from the web" }
        switch phase {
        case .stopped: return "Not running"
        case .automaticWorkOff: return "Automatic work is off"
        case .backgrounded: return "Waiting for the app to be open"
        case .asleep: return "Paused while this Mac sleeps"
        case .connecting: return "Disconnected — reconnecting"
        case .idle: return "Connected — no image work waiting"
        case .pulling: return "Checking for image work"
        case .processing:
            return processingCount > 1 ? "Processing \(processingCount) image jobs" : "Processing 1 image job"
        case .updateRequired: return "Update required to process images"
        }
    }

    var statusSymbol: String {
        if remotePaused, phase == .idle || phase == .pulling { return "pause.circle" }
        switch phase {
        case .stopped: return "stop.circle"
        case .automaticWorkOff: return "power.circle"
        case .backgrounded: return "moon.circle"
        case .asleep: return "zzz"
        case .connecting: return "wifi.exclamationmark"
        case .idle: return "checkmark.circle"
        case .pulling: return "arrow.down.circle"
        case .processing: return "gearshape.2"
        case .updateRequired: return "arrow.down.app"
        }
    }

    /// Phases the member can act on (update, reconnect) read as warnings.
    var statusNeedsAttention: Bool {
        phase == .updateRequired || phase == .connecting || remotePaused || undeliveredResults > 0
    }
}

/// The first row of Activity's "This device" section: the companion worker's live phase, its
/// last error, and results set aside after failed deliveries.
struct CompanionWorkerStatusRow: View {
    let activity: CompanionImageWorkerActivity

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Label(activity.statusTitle, systemImage: activity.statusSymbol)
                    .font(.headline)
                    .foregroundStyle(activity.statusNeedsAttention ? FieldGuideTokens.warning : .primary)
                if activity.phase == .connecting || activity.phase == .pulling {
                    ProgressView().controlSize(.small)
                }
            }
            if activity.phase == .connecting {
                CompanionConnectionProgress(activity: activity)
            }
            if activity.phase == .updateRequired {
                Text("Update Cubby from TestFlight. Other devices keep processing images meanwhile.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            if activity.undeliveredResults > 0 {
                Text(
                    activity.undeliveredResults == 1
                        ? "1 result waiting to deliver"
                        : "\(activity.undeliveredResults) results waiting to deliver"
                )
                .font(.caption)
                if let error = activity.deliveryError {
                    Text(error).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                }
            }
            if let error = activity.lastError, activity.phase != .updateRequired {
                Text(error).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
            }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }
}

/// While reconnecting: which attempt this is and when the next one starts, so a device that
/// cannot subscribe shows that it is still trying and how often.
private struct CompanionConnectionProgress: View {
    let activity: CompanionImageWorkerActivity

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            Text(detail(now: context.date))
                .font(.caption.monospacedDigit())
                .foregroundStyle(.secondary)
        }
    }

    private func detail(now: Date) -> String {
        guard activity.connectionAttempt > 0 else { return "Opening the image-work connection…" }
        let attempt = "Attempt \(activity.connectionAttempt) failed"
        guard let next = activity.nextConnectAt else { return "\(attempt) · trying again now" }
        let seconds = max(0, Int(next.timeIntervalSince(now).rounded(.up)))
        return "\(attempt) · next try in \(seconds)s"
    }
}

/// The top of Activity while image work is parked for an Apple device (`job.deviceBacklog`):
/// how much waits, how many devices are working it, the server's ETA, and a nudge when nothing
/// is processing.
struct DeviceBacklogBannerSection: View {
    let backlog: DeviceBacklogBanner?
    /// The latest `job.deviceBacklog` failure, verbatim; a shown banner keeps its last figures.
    var error: String? = nil
    let thisDeviceProcessing: Bool

    var body: some View {
        if let error {
            Section {
                VStack(alignment: .leading, spacing: 2) {
                    Label("Couldn't load the device backlog", systemImage: "exclamationmark.triangle")
                        .font(.subheadline).foregroundStyle(FieldGuideTokens.warning)
                    Text(error).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                }
                .accessibilityElement(children: .combine)
            }
        }
        if let backlog, backlog.isShown {
            Section {
                NavigationLink(value: Route.entityList(.imageJob, savedView: "waiting-for-apple")) {
                    VStack(alignment: .leading, spacing: 4) {
                        Label(backlog.headline(), systemImage: "iphone.and.arrow.forward")
                            .font(.subheadline)
                        if let notice = backlog.idleNotice(thisDeviceProcessing: thisDeviceProcessing) {
                            Text(notice).font(.caption).foregroundStyle(FieldGuideTokens.warning)
                        }
                    }
                }
                .accessibilityIdentifier("activity.deviceBacklog")
            }
        }
    }
}

/// One processing image job: the generic imageJob row (thumbnail, name, kind, state) opening its
/// detail, then its IPR code, its Run, and the live lease countdown.
struct ProcessingImageJobRow: View {
    let row: EntityRow
    @Environment(AppModel.self) private var appModel

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            NavigationLink(value: Route.entityDetail(.imageJob, id: row.id)) {
                EntityRowView(key: .imageJob, row: row, columns: ["kind", "state"])
            }
            .accessibilityIdentifier("activity.processing.\(row.id)")
            HStack(spacing: 8) {
                Text(row.id).font(.fieldGuideCode).textSelection(.enabled)
                if let run = ProcessingImageJobs.runID(of: row) {
                    Button(run) {
                        appModel.navigator.openRecord(RecordSelection(key: .run, id: run))
                    }
                    .buttonStyle(.borderless)
                    .font(.fieldGuideCode)
                }
                Spacer(minLength: 0)
                if let expiresAt = ProcessingImageJobs.leaseExpiresAt(of: row) {
                    TimelineView(.periodic(from: .now, by: 1)) { context in
                        Text(ProcessingImageJobs.leaseCountdown(expiresAt: expiresAt, now: context.date))
                            .monospacedDigit()
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .font(.caption)
        }
    }
}

/// Processing image jobs held by other devices, one group per Device, then installs that only
/// hold expired leases as one counted row each.
struct OtherDevicesSection: View {
    let processing: ProcessingImageJobs
    let expiredLeaseHolders: [HouseholdQueueOverview.LeaseHolder]
    let error: String?

    var body: some View {
        if !processing.otherDevices.isEmpty || !expiredLeaseHolders.isEmpty || error != nil {
            Section("Other devices") {
                if let error {
                    Text(error).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                }
                ForEach(processing.otherDevices) { group in
                    DeviceGroupHeader(group: group)
                    ForEach(group.rows) { row in ProcessingImageJobRow(row: row) }
                }
                ForEach(expiredLeaseHolders) { holder in
                    LabeledContent {
                        Text(holder.expired, format: .number)
                    } label: {
                        Label {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(holder.executor ?? "Unknown device")
                                Text(holder.expiredLabel).font(.caption)
                                    .foregroundStyle(FieldGuideTokens.warning)
                            }
                        } icon: {
                            Image(systemName: "clock.badge.exclamationmark")
                        }
                    }
                    .accessibilityElement(children: .combine)
                }
            }
        }
    }
}

private struct DeviceGroupHeader: View {
    let group: ProcessingImageJobs.DeviceGroup

    var body: some View {
        let label = LabeledContent {
            Text("\(group.rows.count) processing")
        } label: {
            Label(group.name, systemImage: "macbook.and.iphone").font(.subheadline)
        }
        if group.id.isEmpty {
            label
        } else {
            NavigationLink(value: Route.entityDetail(.device, id: group.id)) { label }
        }
    }
}

/// Activity's household queue from `job.queue`: the Apple device lane (work waiting for any
/// Apple device, linked to its image jobs) and the frontier AI lane, each as server counts by
/// what the work waits on, then Jobs backing off with when they are due again.
struct HouseholdQueueSections: View {
    let queue: HouseholdQueueOverview?
    let error: String?

    var body: some View {
        Section {
            if let queue {
                // A failed refresh keeps the last counts; say so beside them so they are not read
                // as current.
                if let error { QueueRefreshFailureRow(error: error) }
                NavigationLink(value: Route.entityList(.imageJob, savedView: "waiting-for-apple")) {
                    Label(
                        "Waiting for Apple · \(queue.waitingForDeviceCount.formatted())",
                        systemImage: "iphone.and.arrow.forward")
                }
                .accessibilityIdentifier("activity.waitingForApple")
                ReasonCountRows(
                    counts: queue.appleCounts.filter {
                        $0.reason != JobWaitingOnReason.waitingDevice.rawValue
                    },
                    empty: nil)
            } else if let error {
                Text(error).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
            } else {
                ProgressView()
            }
        } header: {
            Text("Apple devices queue")
        }
        if let queue {
            Section("Cloud AI queue") {
                ReasonCountRows(counts: queue.frontierCounts, empty: "No cloud AI work waiting")
            }
            if !queue.backingOff.isEmpty {
                Section("Backing off") {
                    ForEach(queue.backingOff) { job in
                        BackingOffRow(job: job)
                    }
                }
            }
        }
    }
}

/// Activity's Runs needing attention: the saved view's server count, then each listed Run with
/// its `job.runRollups` counts and stall flag.
struct RunsNeedingAttentionRows: View {
    let queue: HouseholdQueueOverview?

    var body: some View {
        NavigationLink(value: Route.entityList(.run, savedView: "attention")) {
            LabeledContent {
                if let count = queue?.runsNeedingAttention { Text(count, format: .number) }
            } label: {
                Label("Runs needing attention", systemImage: "exclamationmark.circle")
            }
        }
        ForEach(queue?.runs ?? []) { run in
            NavigationLink(value: Route.entityDetail(.run, id: run.id)) {
                RunRollupLabel(run: run)
            }
        }
    }
}

extension HouseholdQueueOverview.ReasonCount {
    /// Activity's wording for a waiting-on reason; an unknown reason shows verbatim.
    var title: String {
        switch reason {
        case "due": "Due now"
        case "waiting_device": "Waiting for any Apple device"
        case "waiting_funding": "Waiting for AI funding"
        case "leased": "Leased by a device"
        case "backing_off": "Backing off after failures"
        case "blocked": "Blocked"
        case "paused": "Paused"
        case "update_required": "Waiting for an app update"
        default: reason
        }
    }

    var systemImage: String {
        switch reason {
        case "due": "play.circle"
        case "waiting_device": "iphone.and.arrow.forward"
        case "waiting_funding": "creditcard"
        case "leased": "hourglass"
        case "backing_off": "clock.arrow.circlepath"
        case "blocked": "nosign"
        case "paused": "pause.circle"
        case "update_required": "arrow.down.app"
        default: "questionmark.circle"
        }
    }
}

private struct ReasonCountRows: View {
    let counts: [HouseholdQueueOverview.ReasonCount]
    let empty: String?

    var body: some View {
        if counts.isEmpty, let empty {
            Label(empty, systemImage: "checkmark.circle").foregroundStyle(.secondary)
        }
        ForEach(counts) { count in
            LabeledContent {
                Text(count.count, format: .number)
            } label: {
                Label {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(count.title)
                        if let until = count.until {
                            Text("until \(until, format: .dateTime.month().day().hour().minute())")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                    }
                } icon: {
                    Image(systemName: count.systemImage)
                }
            }
        }
    }
}

/// The latest queue refresh failed while earlier counts stay on screen: the error, verbatim.
private struct QueueRefreshFailureRow: View {
    let error: String

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Label("Couldn't refresh — showing earlier counts", systemImage: "exclamationmark.triangle")
                .font(.subheadline)
                .foregroundStyle(FieldGuideTokens.warning)
            Text(error).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
        }
        .accessibilityElement(children: .combine)
    }
}

private struct BackingOffRow: View {
    let job: HouseholdQueueOverview.BackingOff

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(job.kind).font(.subheadline)
            Text(
                "\(job.attempts) attempts · retries \(job.until, format: .dateTime.month().day().hour().minute())"
            )
            .font(.caption).foregroundStyle(.secondary)
            if let error = job.lastError {
                Text(error).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                    .lineLimit(3)
            }
        }
        .accessibilityElement(children: .combine)
    }
}

private struct RunRollupLabel: View {
    let run: HouseholdQueueOverview.RunRollupRow

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(run.title).font(.subheadline)
            if run.stalled {
                Text("No progress for \(run.stallMinutes) min")
                    .font(.caption).foregroundStyle(FieldGuideTokens.warning)
            }
            if run.waitingForFunding {
                Text("Paused: waiting for AI funding").font(.caption).foregroundStyle(.secondary)
            }
            if let expired = run.expiredLeasesLabel {
                Text(expired).font(.caption).foregroundStyle(FieldGuideTokens.warning)
            }
            if !run.counts.isEmpty {
                Text(run.counts.map { "\($0.count) \($0.title.lowercased())" }.joined(separator: " · "))
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        .accessibilityElement(children: .combine)
    }
}

#Preview("Worker — update required") {
    List {
        CompanionWorkerStatusRow(
            activity: .init(
                phase: .updateRequired, undeliveredResults: 2, deliveryError: "HTTP 426"))
    }
}

#Preview("Worker — processing") {
    List {
        CompanionWorkerStatusRow(activity: .init(phase: .processing, processingCount: 2))
    }
}

/// Synthetic processing rows for previews, kept outside the `#Preview` bodies so the macro
/// expressions stay cheap to type-check.
private func previewProcessingRow(id: String, title: String, device: String, leaseSeconds: Double)
    -> EntityRow
{
    let expires = (try? LenientISO8601DateTranscoder().encode(.now.addingTimeInterval(leaseSeconds))) ?? ""
    return EntityRow(
        id: id, title: title, subtitle: nil, imageURL: nil,
        raw: .object([
            "id": .string(id), "displayName": .string(title), "kind": .string("describe_image"),
            "state": .string("leased"), "runId": .string("RUN-SYN1"),
            "leaseDeviceId": .string(device), "leaseExpiresAt": .string(expires),
        ]))
}

private func previewProcessing() -> ProcessingImageJobs {
    ProcessingImageJobs(
        rows: [
            previewProcessingRow(
                id: "IPR-SYN1", title: "Image description · Synthetic mug", device: "DEV-SYN1",
                leaseSeconds: 42),
            previewProcessingRow(
                id: "IPR-SYN2", title: "Image description · Synthetic lamp", device: "DEV-SYN2",
                leaseSeconds: 18),
        ],
        devices: HouseholdDevices(
            names: ["DEV-SYN1": "Synthetic Mac", "DEV-SYN2": "Synthetic phone"], thisDevice: "DEV-SYN1"))
}

#Preview("Device backlog", traits: .modifier(SignedInPreview())) {
    NavigationStack {
        List {
            DeviceBacklogBannerSection(
                backlog: .init(waiting: 9_733, runsWaiting: 4, workingDevices: 0, etaSeconds: nil),
                thisDeviceProcessing: false)
            DeviceBacklogBannerSection(
                backlog: .init(waiting: 240, runsWaiting: 2, workingDevices: 1, etaSeconds: 12_000),
                thisDeviceProcessing: true)
        }
    }
}

#Preview("Processing on devices", traits: .modifier(SignedInPreview())) {
    let processing = previewProcessing()
    NavigationStack {
        List {
            Section("This device — now") {
                ForEach(processing.thisDevice) { ProcessingImageJobRow(row: $0) }
            }
            OtherDevicesSection(
                processing: processing,
                expiredLeaseHolders: [.init(executor: "Synthetic old phone", live: 0, expired: 15)],
                error: nil)
        }
    }
}

#Preview("Household queue — refresh failed") {
    NavigationStack {
        List {
            HouseholdQueueSections(
                queue: HouseholdQueueOverview(
                    appleCounts: [.init(reason: "waiting_device", count: 14)], frontierCounts: [],
                    backingOff: [], runsNeedingAttention: 0, runs: []),
                error: "The network connection was lost.")
        }
    }
}

#Preview("Household queue") {
    NavigationStack {
        List {
            HouseholdQueueSections(
                queue: HouseholdQueueOverview(
                    appleCounts: [
                        .init(reason: "waiting_device", count: 14), .init(reason: "leased", count: 2),
                    ],
                    frontierCounts: [
                        .init(reason: "due", count: 3),
                        .init(
                            reason: "waiting_funding", count: 40, until: .now.addingTimeInterval(3_600)),
                    ],
                    backingOff: [
                        .init(
                            id: "job-3", kind: "image.cloud", lane: "frontier_ai",
                            until: .now.addingTimeInterval(900), attempts: 6,
                            lastError: "Synthetic provider error")
                    ],
                    runsNeedingAttention: 1,
                    runs: [
                        .init(
                            id: "RUN-SYN1", title: "Synthetic photo batch",
                            counts: [.init(reason: "waiting_funding", count: 12)],
                            waitingForFunding: true, stalled: true, stallMinutes: 15)
                    ]),
                error: nil)
            Section("Household work") {
                RunsNeedingAttentionRows(
                    queue: HouseholdQueueOverview(
                        appleCounts: [], frontierCounts: [], backingOff: [],
                        runsNeedingAttention: 1,
                        runs: [
                            .init(
                                id: "RUN-SYN1", title: "Synthetic photo batch", expiredLeases: 2,
                                stalled: true, stallMinutes: 15)
                        ]))
            }
        }
    }
}
