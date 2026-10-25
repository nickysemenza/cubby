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
            Label(activity.statusTitle, systemImage: activity.statusSymbol)
                .font(.headline)
                .foregroundStyle(activity.statusNeedsAttention ? FieldGuideTokens.warning : .primary)
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

/// Activity's household queue from `job.queue`: the Apple device lane (this device's leases,
/// other devices' leases, work waiting for any Apple device) and the frontier AI lane, each as
/// server counts by what the work waits on, then Jobs backing off with when they are due again.
struct HouseholdQueueSections: View {
    let queue: HouseholdQueueOverview?
    let error: String?
    /// This device's live claims (`CompanionImageWorkerActivity.claimedJobIDs`).
    let claimedImageJobIDs: Set<String>

    var body: some View {
        Section {
            if let queue {
                let split = queue.leases(claimedImageJobIDs: claimedImageJobIDs)
                ReasonCountRows(counts: queue.appleCounts, empty: "No Apple device work waiting")
                ForEach(split.mine) { lease in
                    LeaseRow(lease: lease, isThisDevice: true)
                }
                ForEach(split.others) { lease in
                    LeaseRow(lease: lease, isThisDevice: false)
                }
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
    let empty: String

    var body: some View {
        if counts.isEmpty {
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

private struct LeaseRow: View {
    let lease: HouseholdQueueOverview.Lease
    let isThisDevice: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(isThisDevice ? "This device" : (lease.executor ?? "Unknown device"))
                .font(.subheadline)
            HStack(spacing: 4) {
                Text(lease.kind)
                if lease.expired {
                    Text("· lease expired")
                    Text(lease.leaseExpiresAt, style: .relative)
                    Text("ago")
                } else {
                    Text("· lease ends in")
                    Text(lease.leaseExpiresAt, style: .relative)
                }
            }
            .font(.caption)
            .foregroundStyle(lease.expired ? FieldGuideTokens.destructive : .secondary)
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
                    leases: [
                        .init(
                            id: "job-1", kind: "image.device", imageJobID: "image-job-1",
                            executor: "Synthetic Mac", leaseExpiresAt: .now.addingTimeInterval(45),
                            expired: false),
                        .init(
                            id: "job-2", kind: "image.device", imageJobID: "image-job-2",
                            executor: "Synthetic phone", leaseExpiresAt: .now.addingTimeInterval(-600),
                            expired: true),
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
                error: nil, claimedImageJobIDs: ["image-job-1"])
            Section("Household work") {
                RunsNeedingAttentionRows(
                    queue: HouseholdQueueOverview(
                        appleCounts: [], frontierCounts: [], leases: [], backingOff: [],
                        runsNeedingAttention: 1,
                        runs: [
                            .init(
                                id: "RUN-SYN1", title: "Synthetic photo batch", stalled: true,
                                stallMinutes: 15)
                        ]))
            }
        }
    }
}
