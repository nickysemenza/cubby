import ActivityKit
import Foundation
import Observation

/// The Lock Screen shows one sustained task from the device-local activity register. Server
/// runs and companion jobs are deliberately absent: this install cannot update them while it
/// is suspended without a server ActivityKit push channel.
struct DeviceWorkLiveSelection: Equatable {
    let id: String
    let title: String
    let detail: String
    let progress: Double?
    let additionalCount: Int

    static func select(_ activities: [BackgroundActivity], at now: Date) -> Self? {
        let eligible = activities.filter { activity in
            switch activity.kind {
            case .libraryScan, .hashRepair, .classificationSweep, .metadataSync, .upload:
                now.timeIntervalSince(activity.startedAt) >= 30
            case .companionJob, .browserBridgeSync:
                false
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
            additionalCount: eligible.count - 1)
    }

    func contentState(estimatedRemaining: String? = nil) -> DeviceWorkAttributes.ContentState {
        .init(
            title: title, detail: detail, progress: progress,
            estimatedRemaining: estimatedRemaining,
            additionalCount: additionalCount, localActivityID: id)
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

@MainActor
final class DeviceWorkLiveActivityCoordinator {
    static let shared = DeviceWorkLiveActivityCoordinator()

    private weak var model: AppModel?
    private var foreground = false
    private var loop: Task<Void, Never>?
    private var observing = false
    private var lastPublished: DeviceWorkAttributes.ContentState?
    private var lastUpdate = Date.distantPast
    private var progressETA = DeviceWorkProgressETA()

    func start(model: AppModel, foreground: Bool) {
        self.model = model
        self.foreground = foreground
        if !observing {
            observing = true
            armObservation()
        }
        ensureLoop()
    }

    func setForeground(_ foreground: Bool) {
        self.foreground = foreground
        ensureLoop()
    }

    private func armObservation() {
        withObservationTracking {
            _ = model?.phase
            _ = model?.backgroundActivity.visibleActivities
        } onChange: { [weak self] in
            Task { @MainActor [weak self] in
                self?.armObservation()
                self?.ensureLoop()
            }
        }
    }

    private func ensureLoop() {
        guard loop == nil else { return }
        loop = Task { [weak self] in
            guard let self else { return }
            repeat {
                await reconcile()
                guard !Task.isCancelled else { break }
                let hasWork = !(model?.backgroundActivity.visibleActivities.isEmpty ?? true)
                let hasLiveActivity = !Activity<DeviceWorkAttributes>.activities.isEmpty
                if !hasWork && !hasLiveActivity { break }
                try? await Task.sleep(for: .seconds(5))
            } while !Task.isCancelled
            loop = nil
        }
    }

    private func reconcile() async {
        guard let model, model.phase != .restoring else { return }
        let snapshot = DeviceWorkLiveSelection.select(model.backgroundActivity.visibleActivities, at: .now)
        progressETA.record(snapshot, at: .now)
        let activities = Activity<DeviceWorkAttributes>.activities
        for extra in activities.dropFirst() { await extra.end(nil, dismissalPolicy: .immediate) }
        guard let snapshot else {
            if let activity = activities.first { await activity.end(nil, dismissalPolicy: .immediate) }
            lastPublished = nil
            return
        }
        let state = snapshot.contentState(
            estimatedRemaining: progressETA.remaining(at: .now).map(PhotoStageETA.format))
        if let activity = activities.first {
            let changedTask = lastPublished?.localActivityID != state.localActivityID
            let due = Date.now.timeIntervalSince(lastUpdate) >= 15
            guard changedTask || (due && state != lastPublished) else { return }
            await activity.update(
                ActivityContent(state: state, staleDate: Date.now.addingTimeInterval(90)))
        } else {
            guard foreground, ActivityAuthorizationInfo().areActivitiesEnabled else { return }
            do {
                _ = try Activity.request(
                    attributes: DeviceWorkAttributes(sessionID: UUID().uuidString),
                    content: ActivityContent(
                        state: state, staleDate: Date.now.addingTimeInterval(90)),
                    pushType: nil)
            } catch {
                Diagnostics.report(error, context: "deviceWork.liveActivity.start")
                return
            }
        }
        lastPublished = state
        lastUpdate = .now
    }
}
