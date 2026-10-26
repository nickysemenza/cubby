import ActivityKit
import CubbyKit
import Foundation
import Observation

/// One coordinator owns device work and device-started imports. Local progress stays separate
/// from per-batch ActivityKit pushes, which update sealed imports while the app is asleep.
@MainActor
final class DeviceWorkLiveActivityCoordinator {
    static let shared = DeviceWorkLiveActivityCoordinator()
    private var tokenTasks: [String: Task<Void, Never>] = [:]
    private var trackedActivities: [String: String] = [:]
    private var startedBatches: Set<String> = []
    private var activityBatches: [String: String] =
        UserDefaults.standard.dictionary(
            forKey: "photoRunActivityBatches") as? [String: String] ?? [:]
    private var lastStates: [String: PhotoRunActivityAttributes.ContentState] = [:]

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
            _ = model?.photoImportFlows
            for flow in model?.latestPhotoImportFlows ?? [] {
                _ = flow.isBusy
                _ = flow.needsAttention
                _ = flow.session.phase
                _ = flow.session.progress
                _ = flow.session.runID
            }
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
                guard model?.phase == .signedIn else { break }
                let hasWork = !(model?.backgroundActivity.visibleActivities.isEmpty ?? true)
                let hasLiveActivity =
                    Activity<DeviceWorkAttributes>.activities.contains {
                        $0.activityState == .active || $0.activityState == .stale
                    }
                    || Activity<PhotoRunActivityAttributes>.activities.contains {
                        $0.activityState == .active || $0.activityState == .stale
                    }
                let hasImports = model?.hasPendingPhotoImports ?? false
                if !hasWork && !hasLiveActivity && !hasImports { break }
                try? await Task.sleep(for: .seconds(5))
            } while !Task.isCancelled
            loop = nil
        }
    }

    private func reconcile() async {
        guard let model, model.phase != .restoring else { return }
        await reconcileImports(model: model, foreground: foreground)
        await reconcileLocalWork(model: model)
    }

    private func reconcileLocalWork(model: AppModel) async {
        guard model.phase == .signedIn else {
            for activity in Activity<DeviceWorkAttributes>.activities {
                await activity.end(nil, dismissalPolicy: .immediate)
            }
            lastPublished = nil
            progressETA.record(nil, at: .now)
            return
        }
        let uploadsWithRunActivity = Set(
            Activity<PhotoRunActivityAttributes>.activities.filter {
                $0.activityState == .active || $0.activityState == .stale
            }.map { $0.attributes.runId })
        let handledLocally = Set(
            model.photoImportFlows.filter {
                $0.session.runID.map(uploadsWithRunActivity.contains) ?? false
            }.flatMap { $0.currentActivities.map(\.id) })
        let snapshot = DeviceWorkLiveSelection.select(
            model.backgroundActivity.visibleActivities.filter { !handledLocally.contains($0.id) }, at: .now)
        progressETA.record(snapshot, at: .now)
        let activityIDs = Activity<DeviceWorkAttributes>.activities.filter {
            $0.activityState == .active || $0.activityState == .stale
        }.map(\.id)
        for id in activityIDs.dropFirst() { await Self.endLocalActivity(id) }
        guard let snapshot else {
            if let id = activityIDs.first { await Self.endLocalActivity(id) }
            lastPublished = nil
            return
        }
        let state = snapshot.contentState(
            // The queue detail already carries the server's pace. Local percentage changes use
            // a frozen waiting baseline and must not be extrapolated into a second ETA.
            estimatedRemaining: snapshot.id == "companion-image-queue"
                ? nil : progressETA.remaining(at: .now).map(PhotoStageETA.format))
        if let id = activityIDs.first {
            let changedTask = lastPublished?.localActivityID != state.localActivityID
            let due = Date.now.timeIntervalSince(lastUpdate) >= 15
            guard changedTask || (due && state != lastPublished) else { return }
            await Self.updateLocalActivity(id, state: state)
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

    private func reconcileImports(model: AppModel, foreground: Bool) async {
        guard model.phase == .signedIn else {
            for task in tokenTasks.values { task.cancel() }
            tokenTasks.removeAll()
            trackedActivities.removeAll()
            lastStates.removeAll()
            startedBatches.removeAll()
            activityBatches.removeAll()
            UserDefaults.standard.removeObject(forKey: "photoRunActivityBatches")
            for activity in Activity<PhotoRunActivityAttributes>.activities {
                await activity.end(nil, dismissalPolicy: .immediate)
            }
            return
        }
        let flows = model.latestPhotoImportFlows
        defer { UserDefaults.standard.set(activityBatches, forKey: "photoRunActivityBatches") }
        let active = Activity<PhotoRunActivityAttributes>.activities
        for (runID, id) in trackedActivities {
            if !active.contains(where: {
                $0.id == id && ($0.activityState == .active || $0.activityState == .stale)
            }) {
                tokenTasks.removeValue(forKey: runID)?.cancel()
                trackedActivities.removeValue(forKey: runID)
                lastStates.removeValue(forKey: runID)
                activityBatches.removeValue(forKey: id)
            }
        }
        if foreground {
            for activity in Activity<PhotoRunActivityAttributes>.activities
            where activity.activityState == .active || activity.activityState == .stale {
                let runID = activity.attributes.runId
                if let latest = flows.first(where: { $0.session.runID == runID }),
                    activityBatches[activity.id] != latest.liveActivityBatchID
                {
                    continue
                }
                guard
                    !model.photoImportFlows.contains(where: {
                        $0.session.runID == runID
                            && ($0.isBusy || $0.needsAttention || $0.session.phase == .cancelled)
                    })
                else { continue }
                do {
                    let lifecycle = try await model.client.photoRunReview(.init(runId: runID)).lifecycle
                    let phase = lifecycle.phase.rawValue
                    let state = PhotoRunActivityAttributes.ContentState(
                        phase: phase,
                        title: phase == "completed"
                            ? "Photo import complete"
                            : (phase == "needs_attention"
                                ? "Photo import needs attention"
                                : (["ready_for_review", "ready_for_handoff"].contains(phase)
                                    ? "Photo import ready" : "Processing photos")),
                        detail: lifecycle.dispatchError
                            ?? "Described \(lifecycle.describedImageCount) of \(lifecycle.finalizedImageCount)",
                        completed: lifecycle.describedImageCount, total: lifecycle.finalizedImageCount,
                        needsAttention: phase == "needs_attention")
                    if state.shouldEnd {
                        await end(activity, state: state, client: model.client)
                    } else if lastStates[runID] != state {
                        await Self.updateActivity(activity.id, state: state)
                        lastStates[runID] = state
                    }
                } catch { Diagnostics.report(error, context: "photos.import.liveActivity.refresh") }
            }
        }
        for flow in flows {
            guard let runID = flow.session.runID else { continue }
            let batchID = flow.liveActivityBatchID
            let ownedActivityIDs = Set(activityBatches.filter { $0.value == batchID }.map(\.key))
            let progress = flow.session.progress
            let uploading = progress.uploaded < progress.total
            if flow.needsAttention || flow.session.phase == .cancelled {
                let state = PhotoRunActivityAttributes.ContentState(
                    phase: flow.needsAttention ? "failed" : "cancelled",
                    title: flow.needsAttention ? "Photo import needs attention" : "Photo import cancelled",
                    detail: "Open Cubby for import details",
                    completed: progress.transferred, total: progress.total,
                    needsAttention: flow.needsAttention)
                for activity in Activity<PhotoRunActivityAttributes>.activities
                where activity.attributes.runId == runID && ownedActivityIDs.contains(activity.id)
                    && (activity.activityState == .active || activity.activityState == .stale)
                {
                    await end(activity, state: state, client: model.client)
                    // Only an explicit retry may create another Activity for this failed batch.
                    startedBatches.remove(batchID)
                }
                continue
            }
            guard flow.isBusy || flow.session.phase == .complete else { continue }
            let state = PhotoRunActivityAttributes.ContentState(
                phase: uploading ? "uploading" : "describing",
                title: "Importing photos",
                detail: progress.waitingReason
                    ?? (uploading
                        ? "Transferred \(progress.transferred) of \(progress.total)"
                        : "Photos imported; processing continues"),
                completed: progress.transferred, total: progress.total, needsAttention: false)
            // An active prior batch can still receive its late APNs end. Give this batch
            // a distinct Activity/token and never let a retained older flow update it.
            for previous in Activity<PhotoRunActivityAttributes>.activities
            where
                previous.attributes.runId == runID && activityBatches[previous.id] != flow.liveActivityBatchID
            {
                await previous.end(nil, dismissalPolicy: .immediate)
                tokenTasks.removeValue(forKey: runID)?.cancel()
                trackedActivities.removeValue(forKey: runID)
                lastStates.removeValue(forKey: runID)
                activityBatches.removeValue(forKey: previous.id)
            }
            let activityID: String
            if let existing = Activity<PhotoRunActivityAttributes>.activities.first(where: {
                $0.attributes.runId == runID
                    && ownedActivityIDs.contains($0.id)
                    && ($0.activityState == .active || $0.activityState == .stale)
            }) {
                activityID = existing.id
                if uploading, lastStates[runID] != state {
                    await Self.updateActivity(existing.id, state: state)
                }
            } else {
                guard foreground, flow.isBusy, uploading, !startedBatches.contains(flow.liveActivityBatchID),
                    ActivityAuthorizationInfo().areActivitiesEnabled
                else { continue }
                do {
                    let activity = try Activity.request(
                        attributes: PhotoRunActivityAttributes(runId: runID),
                        content: ActivityContent(state: state, staleDate: nil), pushType: .token)
                    activityID = activity.id
                } catch {
                    Diagnostics.report(error, context: "photos.import.liveActivity.start")
                    continue
                }
            }
            startedBatches.insert(flow.liveActivityBatchID)
            trackedActivities[runID] = activityID
            activityBatches[activityID] = flow.liveActivityBatchID
            UserDefaults.standard.set(activityBatches, forKey: "photoRunActivityBatches")
            lastStates[runID] = state
            if tokenTasks[runID] == nil {
                let client = model.client
                tokenTasks[runID] = Task {
                    guard
                        let activity = Activity<PhotoRunActivityAttributes>.activities.first(where: {
                            $0.id == activityID
                        })
                    else { return }
                    for await token in activity.pushTokenUpdates {
                        guard !Task.isCancelled else { break }
                        do {
                            var input = PhotoRunLiveActivityRegisterInput(
                                runId: runID, pushToken: token.map { String(format: "%02x", $0) }.joined(),
                                apnsEnvironment: .production,
                                appIdentity: AppleAppIdentity.current == .development
                                    ? .development : .production)
                            #if DEBUG
                                input.apnsEnvironment = .development
                            #endif
                            _ = try await client.registerPhotoRunLiveActivity(input)
                        } catch {
                            Diagnostics.report(error, context: "photos.import.liveActivity.register")
                        }
                    }
                }
            }
        }
    }
    private func end(
        _ activity: Activity<PhotoRunActivityAttributes>,
        state: PhotoRunActivityAttributes.ContentState, client: CubbyClient
    ) async {
        let runID = activity.attributes.runId
        tokenTasks.removeValue(forKey: runID)?.cancel()
        trackedActivities.removeValue(forKey: runID)
        lastStates.removeValue(forKey: runID)
        activityBatches.removeValue(forKey: activity.id)
        await Self.endRunActivity(activity.id, state: state)
        do { _ = try await client.endPhotoRunLiveActivity(.init(runId: runID)) } catch {
            Diagnostics.report(error, context: "photos.import.liveActivity.end")
        }
    }

    // ActivityKit's Activity handles are not Sendable. Resolve each handle in the
    // nonisolated operation instead of sending an actor-owned handle across executors.
    nonisolated private static func endLocalActivity(_ id: String) async {
        guard let activity = Activity<DeviceWorkAttributes>.activities.first(where: { $0.id == id })
        else { return }
        await activity.end(
            ActivityContent(state: activity.content.state.ending(), staleDate: nil),
            dismissalPolicy: .immediate)
    }

    nonisolated private static func updateLocalActivity(
        _ id: String, state: DeviceWorkAttributes.ContentState
    ) async {
        guard let activity = Activity<DeviceWorkAttributes>.activities.first(where: { $0.id == id })
        else { return }
        await activity.update(ActivityContent(state: state, staleDate: Date.now.addingTimeInterval(90)))
    }

    nonisolated private static func endRunActivity(
        _ id: String, state: PhotoRunActivityAttributes.ContentState
    ) async {
        guard let activity = Activity<PhotoRunActivityAttributes>.activities.first(where: { $0.id == id })
        else { return }
        await activity.end(
            ActivityContent(state: state, staleDate: nil),
            dismissalPolicy: .after(state.dismissalDate(at: .now)))
    }

    nonisolated private static func updateActivity(
        _ id: String, state: PhotoRunActivityAttributes.ContentState
    ) async {
        guard let activity = Activity<PhotoRunActivityAttributes>.activities.first(where: { $0.id == id })
        else { return }
        await activity.update(ActivityContent(state: state, staleDate: nil))
    }

}
