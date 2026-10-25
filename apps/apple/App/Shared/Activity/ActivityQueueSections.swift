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

#Preview("Companion connection", traits: .modifier(SignedInPreview())) {
    List { CompanionWorkerStatusRow(activity: .init(phase: .connecting)) }
}
