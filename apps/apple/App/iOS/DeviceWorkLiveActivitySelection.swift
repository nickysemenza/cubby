import CubbyKit
import Foundation

/// Generic sustained device work uses the local activity register. Photo imports with their
/// own per-run push activity are filtered out. Queue progress only reflects an active worker window.
struct DeviceWorkLiveSelection: Equatable {
    let id: String
    let title: String
    let detail: String
    let progress: Double?
    let additionalCount: Int
    let symbol: String
    let destination: String?

    static func select(_ activities: [BackgroundActivity], at now: Date) -> Self? {
        let eligible = activities.filter { activity in
            switch activity.kind {
            case .libraryScan, .hashRepair, .classificationSweep, .metadataSync:
                now.timeIntervalSince(activity.startedAt) >= 30
            case .upload:
                activity.isUserInitiated || now.timeIntervalSince(activity.startedAt) >= 30
            case .companionJob:
                true
            }
        }
        guard
            let primary = eligible.min(by: { left, right in
                if left.isUserInitiated != right.isUserInitiated { return left.isUserInitiated }
                if (left.progress != nil) != (right.progress != nil) { return left.progress != nil }
                return left.startedAt < right.startedAt
            })
        else { return nil }
        return Self(
            id: primary.id, title: primary.title,
            detail: primary.detail ?? "Working on this device",
            progress: primary.progress.map { min(1, max(0, $0)) },
            additionalCount: eligible.count - 1,
            symbol: primary.kind.liveActivitySymbol,
            destination: primary.link.liveActivityURL?.absoluteString)
    }

    func contentState(estimatedRemaining: String? = nil) -> DeviceWorkAttributes.ContentState {
        .init(
            title: title, detail: detail, progress: progress,
            estimatedRemaining: estimatedRemaining,
            additionalCount: additionalCount, localActivityID: id,
            kindSymbol: symbol, destination: destination)
    }
}

extension BackgroundActivity.Kind {
    var liveActivitySymbol: String {
        switch self {
        case .companionJob: "photo.badge.gearshape"
        case .libraryScan: "photo.on.rectangle.angled"
        case .hashRepair: "checkmark.shield"
        case .classificationSweep: "tag"
        case .metadataSync: "arrow.trianglehead.2.clockwise"
        case .upload: "arrow.up.doc"
        }
    }
}

extension BackgroundActivity.Link {
    var liveActivityURL: URL? {
        switch self {
        case .serverRun(let id): URL(string: "cubby://activity/\(id)")
        case .localActivity(let id): URL(string: "cubby://activity/local/\(id)")
        case .photos: URL(string: "cubby://photos")
        case .activity: URL(string: "cubby://activity")
        }
    }
}

/// Estimate from the last minute of observed progress. A restarted or different task discards
/// the old rate, and a short sample span cannot produce a useful estimate.
struct DeviceWorkProgressETA {
    private struct Sample {
        let at: Date
        let progress: Double
    }

    private var taskID: String?
    private var samples: [Sample] = []

    mutating func record(_ selection: DeviceWorkLiveSelection?, at now: Date) {
        guard let selection, let progress = selection.progress, progress < 1 else {
            taskID = nil
            samples = []
            return
        }
        if taskID != selection.id || (samples.last.map { progress < $0.progress } ?? false) {
            taskID = selection.id
            samples = []
        }
        samples.append(Sample(at: now, progress: progress))
        if let firstInWindow = samples.firstIndex(where: { now.timeIntervalSince($0.at) <= 60 }),
            firstInWindow > 1
        {
            samples.removeFirst(firstInWindow - 1)
        }
    }

    func remaining(at now: Date) -> TimeInterval? {
        guard let first = samples.first, let last = samples.last else { return nil }
        let span = last.at.timeIntervalSince(first.at)
        let advanced = last.progress - first.progress
        guard span >= 10, advanced > 0 else { return nil }
        return max(0, (1 - last.progress) * span / advanced - now.timeIntervalSince(last.at))
    }
}
