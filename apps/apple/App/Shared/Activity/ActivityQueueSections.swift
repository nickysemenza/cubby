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

/// Activity's household queue: the Apple device lane and the frontier AI lane, from server
/// counts (`HouseholdQueueOverview`). Each count opens the matching filtered Image job list.
struct HouseholdQueueSections: View {
    let queue: HouseholdQueueOverview?
    let error: String?

    var body: some View {
        Section {
            if let queue {
                countLink(
                    "Waiting for any Apple device", systemImage: "iphone.and.arrow.forward",
                    count: queue.waitingForAppleDevice, state: .waitingForDevice)
                countLink(
                    "Leased by Apple devices", systemImage: "hourglass", count: queue.leasedCount,
                    state: .leased)
                ForEach(queue.myLeases) { lease in
                    LeaseRow(lease: lease, isThisDevice: true)
                }
                ForEach(queue.otherLeases) { lease in
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
                countLink(
                    "Queued for cloud processing", systemImage: "cloud", count: queue.frontierQueued,
                    state: .pending)
            }
        }
    }

    private func countLink(
        _ title: String, systemImage: String, count: Int, state: HouseholdQueueOverview.ImageJobState
    ) -> some View {
        NavigationLink(
            value: Route.entityList(.imageJob, filters: HouseholdQueueOverview.imageJobFilter(state))
        ) {
            LabeledContent {
                Text(count, format: .number)
            } label: {
                Label(title, systemImage: systemImage)
            }
        }
    }
}

private struct LeaseRow: View {
    let lease: HouseholdQueueOverview.Lease
    let isThisDevice: Bool

    var body: some View {
        NavigationLink(value: Route.entityDetail(.imageJob, id: lease.id)) {
            VStack(alignment: .leading, spacing: 2) {
                Text(lease.title).font(.subheadline)
                HStack(spacing: 4) {
                    Text(isThisDevice ? "This device" : (lease.executor ?? "Unknown device"))
                    if let leasedAt = lease.leasedAt {
                        Text("· leased")
                        Text(leasedAt, style: .relative)
                    }
                    if lease.expired == true {
                        Text("· lease expired").foregroundStyle(FieldGuideTokens.destructive)
                    }
                }
                .font(.caption).foregroundStyle(.secondary)
            }
        }
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
                    myLeases: [
                        .init(id: "IPR-1", title: "Synthetic job", executor: "Mac", leasedAt: .now)
                    ],
                    otherLeases: [
                        .init(
                            id: "IPR-2", title: "Synthetic job 2", executor: "Hall phone",
                            leasedAt: .now.addingTimeInterval(-600))
                    ],
                    leasedCount: 2, waitingForAppleDevice: 14, frontierQueued: 3,
                    runsNeedingAttention: 1),
                error: nil)
        }
    }
}
