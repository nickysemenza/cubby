import Foundation

/// One unit of work the native app is doing right now, on this device or on the server. Field
/// names deliberately mirror the server `ActivityRun` (`packages/schemas/src/activity.ts`) so a
/// later change can post these server-side without a reshape.
struct BackgroundActivity: Identifiable, Hashable, Sendable {
    enum Kind: String, Hashable, Sendable {
        case companionJob
        case libraryScan
        case hashRepair
        case classificationSweep
        case metadataSync
        case browserBridgeSync
        case upload
    }

    enum Phase: String, Hashable, Sendable {
        case queued
        case running
        case finishing
    }

    /// Where tapping this activity should take the user. Only `.serverRun` deep-links into the
    /// shared Activity list's server-side run detail — device-local work (a library scan, a hash
    /// repair, a classification sweep, a browser-bridge sync, a manual photo upload) links to its
    /// own `.localActivity` id instead, resolved against whatever is currently reporting activities.
    enum Link: Hashable, Sendable {
        case serverRun(String)
        case localActivity(String)
        case photos
    }

    let id: String
    let kind: Kind
    let title: String
    let phase: Phase
    /// `0...1`, or `nil` for indeterminate work.
    var progress: Double?
    var detail: String?
    let startedAt: Date
    let link: Link
    let isUserInitiated: Bool
    let isCancellable: Bool
}

extension BackgroundActivity.Kind {
    /// The device-local Photos-screen work `BackgroundActivityCenter.slice(_:)` scopes a
    /// Photos-screen strip to, so it can never phrase things differently from the iOS bar or the
    /// macOS sidebar — both read the same `primary`/`aggregateProgress`/`summary` logic, just over
    /// a filtered `visibleActivities`.
    static let photoLibrary: Set<Self> = [.libraryScan, .hashRepair, .classificationSweep, .metadataSync]
}
