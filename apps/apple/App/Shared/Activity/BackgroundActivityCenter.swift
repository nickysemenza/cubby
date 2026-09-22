import CubbyKit
import Foundation
import Observation

/// A live source of device-local background work. Adopted by the stores that already track their
/// own progress (`PhotoLibraryStore`'s scan, `PhotoMatchStore`'s repair,
/// `PhotoClassificationSweep`'s sweep, `BrowserBridgeSettingsModel`'s sync) so
/// `BackgroundActivityCenter` never duplicates their state — it only reads `currentActivities`
/// fresh on every access.
@MainActor
protocol BackgroundActivitySource: AnyObject {
    var currentActivities: [BackgroundActivity] { get }
}

/// The app-wide register of what this device is doing right now: one place the iOS bottom
/// accessory, the macOS sidebar, and the Activity screen's "This device" section all read from.
///
/// Two feeds:
/// - Observable sources (`register(_:)`) — already-`@Observable` stores that track their own
///   progress. Held weakly so registering never extends a source's lifetime; `activities` reads
///   `currentActivities` from each fresh on every access, so a producer can never leave a stale
///   entry behind.
/// - Transient activities (`begin`/`update`/`end`) — one-off, non-observable work (the photo
///   import upload) that has no natural home to poll.
@Observable
@MainActor
final class BackgroundActivityCenter {
    /// Type-erases a registered source while holding it weakly, so a source that deallocates
    /// simply stops contributing activities rather than requiring explicit unregistration.
    private struct RegisteredSource {
        private weak var source: AnyObject?
        private let read: (AnyObject) -> [BackgroundActivity]

        init<Source: BackgroundActivitySource>(_ source: Source) {
            self.source = source
            self.read = { ($0 as! Source).currentActivities }
        }

        var currentActivities: [BackgroundActivity] {
            source.map(read) ?? []
        }
    }

    @ObservationIgnored private var sources: [RegisteredSource] = []
    private var transientActivities: [String: BackgroundActivity] = [:]
    @ObservationIgnored private var cancelHandlers: [String: () -> Void] = [:]

    /// PR 2 will bind this to the real device-participation setting; until then every device
    /// participates and sees every activity.
    var participationEnabled = true

    func register(_ source: any BackgroundActivitySource) {
        sources.append(RegisteredSource(source))
    }

    /// Every activity this device currently knows about, freshly read from every registered
    /// source plus whatever transient work is in flight. Order is not significant — consumers
    /// that need a stable primary use `primary`.
    var activities: [BackgroundActivity] {
        sources.flatMap(\.currentActivities)
            + transientActivities.values.sorted { $0.startedAt < $1.startedAt }
    }

    /// `activities`, gated by `participationEnabled`: a viewer-only install still sees its own
    /// explicit, user-initiated work (a manual photo upload), just not automatic background jobs.
    var visibleActivities: [BackgroundActivity] {
        participationEnabled ? activities : activities.filter(\.isUserInitiated)
    }

    /// User-initiated first, then determinate progress, then earliest `startedAt` — the activity a
    /// single-line summary or a tap with no specific target should surface.
    var primary: BackgroundActivity? {
        Self.primary(among: visibleActivities)
    }

    /// The mean of every visible activity's determinate progress, or `nil` when none report one.
    var aggregateProgress: Double? {
        let determinate = visibleActivities.compactMap(\.progress)
        guard !determinate.isEmpty else { return nil }
        return determinate.reduce(0, +) / Double(determinate.count)
    }

    /// A single line for the compact surfaces (the iOS bar's inline state, a notification): one
    /// activity reads as "Scanning library · 41%"; several as "3 tasks · Scanning library 41%".
    /// `nil` when nothing is running.
    var summary: String? {
        let visible = visibleActivities
        guard !visible.isEmpty else { return nil }
        let percent = aggregateProgress.map { "\(Int(($0 * 100).rounded()))%" }
        guard visible.count > 1, let primary = Self.primary(among: visible) else {
            let title = visible[0].title
            return percent.map { "\(title) · \($0)" } ?? title
        }
        let head = "\(visible.count) tasks · \(primary.title)"
        return percent.map { "\(head) \($0)" } ?? head
    }

    private static func primary(among activities: [BackgroundActivity]) -> BackgroundActivity? {
        activities.min { lhs, rhs in
            if lhs.isUserInitiated != rhs.isUserInitiated { return lhs.isUserInitiated }
            let lhsDeterminate = lhs.progress != nil
            let rhsDeterminate = rhs.progress != nil
            if lhsDeterminate != rhsDeterminate { return lhsDeterminate }
            return lhs.startedAt < rhs.startedAt
        }
    }

    // MARK: Transient activities

    /// Registers one non-observable, one-off activity (the photo import upload) and returns its
    /// id for later `update`/`end` calls.
    @discardableResult
    func begin(_ activity: BackgroundActivity) -> String {
        transientActivities[activity.id] = activity
        return activity.id
    }

    /// Updates a transient activity in place. Only the parameters passed are changed; omit one to
    /// leave it as-is.
    func update(id: String, progress: Double? = nil, detail: String? = nil) {
        guard var activity = transientActivities[id] else { return }
        if let progress { activity.progress = progress }
        if let detail { activity.detail = detail }
        transientActivities[id] = activity
    }

    /// Ends a transient activity. Idempotent: ending an id that is not tracked (already ended, or
    /// never begun) is a no-op.
    func end(id: String) {
        transientActivities.removeValue(forKey: id)
        cancelHandlers.removeValue(forKey: id)
    }

    /// Lets a transient activity's owner supply the actual cancellation for `cancel(id:)` to
    /// invoke, without the center needing to know how that work is structured.
    func register(cancel: @escaping () -> Void, for id: String) {
        cancelHandlers[id] = cancel
    }

    /// Invokes the cancel handler registered for `id`, if any. A no-op for an activity that never
    /// registered one (`isCancellable == false`).
    func cancel(id: String) {
        cancelHandlers[id]?()
    }
}

// MARK: - Observable sources

extension PhotoLibraryStore: BackgroundActivitySource {
    var currentActivities: [BackgroundActivity] {
        guard isScanning else { return [] }
        let total = count
        let progress = total > 0 ? Double(min(scannedCount, total)) / Double(total) : nil
        return [
            BackgroundActivity(
                id: "photo-library-scan",
                kind: .libraryScan,
                title: "Scanning library",
                phase: .running,
                progress: progress,
                detail: total > 0 ? "\(min(scannedCount + 1, total)) of \(total)" : nil,
                startedAt: loadingStartedAt ?? .now,
                link: .localActivity("photo-library-scan"),
                isUserInitiated: false,
                isCancellable: false)
        ]
    }
}

extension PhotoMatchStore: BackgroundActivitySource {
    var currentActivities: [BackgroundActivity] {
        guard isRepairing else { return [] }
        let total = totalCount
        let completed = max(0, total - remainingCount)
        let progress = total > 0 ? Double(completed) / Double(total) : nil
        return [
            BackgroundActivity(
                id: "photo-hash-repair",
                kind: .hashRepair,
                title: "Repairing photo hashes",
                phase: .running,
                progress: progress,
                detail: total > 0 ? "\(completed) of \(total)" : nil,
                startedAt: .now,
                link: .localActivity("photo-hash-repair"),
                isUserInitiated: false,
                isCancellable: false)
        ]
    }
}

extension PhotoClassificationSweep: BackgroundActivitySource {
    var currentActivities: [BackgroundActivity] {
        guard isRunning, totalCount > 0 else { return [] }
        let progress = Double(min(analysedCount, totalCount)) / Double(totalCount)
        return [
            BackgroundActivity(
                id: "photo-classification-sweep",
                kind: .classificationSweep,
                title: "Analysing photos",
                phase: .running,
                progress: progress,
                detail: "\(analysedCount) of \(totalCount)",
                startedAt: .now,
                link: .localActivity("photo-classification-sweep"),
                isUserInitiated: false,
                isCancellable: false)
        ]
    }
}

/// The purchase-import browser bridge only exists on macOS, but `BrowserBridgeSettingsModel`
/// itself compiles on every platform (it simply never connects on iOS) — see
/// `apps/apple/App/Shared/PurchaseImport/BrowserBridgeSettingsModel.swift`.
extension BrowserBridgeSettingsModel: BackgroundActivitySource {
    var currentActivities: [BackgroundActivity] {
        guard isSyncing else { return [] }
        return [
            BackgroundActivity(
                id: "browser-bridge-sync",
                kind: .browserBridgeSync,
                title: "Running purchase import",
                phase: .running,
                progress: nil,
                detail: nil,
                startedAt: .now,
                link: .localActivity("browser-bridge-sync"),
                isUserInitiated: true,
                isCancellable: false)
        ]
    }
}

/// A thin adapter over `AppModel.companionImageActivity`: the companion websocket worker is a
/// value type (`CompanionImageWorkerActivity`), so it cannot itself conform to a class-bound
/// protocol. This mirrors `AppModel.localExecutionLabel`'s old title mapping exactly, and — unlike
/// every other source above — deep-links to the server run the companion job is processing rather
/// than a local activity id, since the job itself runs server-side.
final class CompanionActivitySource: BackgroundActivitySource {
    private let activity: () -> CompanionImageWorkerActivity

    init(activity: @escaping () -> CompanionImageWorkerActivity) {
        self.activity = activity
    }

    var currentActivities: [BackgroundActivity] {
        let activity = self.activity()
        guard activity.phase == .processing else { return [] }
        let title = activity.kind == "subject_lift" ? "Creating image cutout" : "Describing image"
        let link: BackgroundActivity.Link =
            activity.jobID.map { .serverRun($0) } ?? .localActivity("companion-image-job")
        return [
            BackgroundActivity(
                id: activity.jobID ?? "companion-image-job",
                kind: .companionJob,
                title: title,
                phase: .running,
                progress: nil,
                detail: nil,
                startedAt: activity.startedAt ?? .now,
                link: link,
                isUserInitiated: false,
                isCancellable: false)
        ]
    }
}
