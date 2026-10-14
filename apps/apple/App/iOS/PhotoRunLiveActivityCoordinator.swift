import ActivityKit
import CubbyKit
import Foundation

/// Upload progress comes from this device; once a batch is sealed, server ActivityKit pushes
/// own describing, grouping, handoff, attention, review, and completion while the app is asleep.
@MainActor
final class PhotoRunLiveActivityCoordinator {
    static let shared = PhotoRunLiveActivityCoordinator()
    private var tokenTasks: [String: Task<Void, Never>] = [:]
    private var trackedActivities: [String: String] = [:]
    private var startedBatches: Set<String> = []
    private var activityBatches: [String: String] =
        UserDefaults.standard.dictionary(
            forKey: "photoRunActivityBatches") as? [String: String] ?? [:]
    private var lastStates: [String: PhotoRunActivityAttributes.ContentState] = [:]

    func reconcile(model: AppModel, foreground: Bool) async {
        guard model.phase == .signedIn else {
            for task in tokenTasks.values { task.cancel() }
            tokenTasks.removeAll()
            for activity in Activity<PhotoRunActivityAttributes>.activities {
                await activity.end(nil, dismissalPolicy: .immediate)
            }
            return
        }
        let flows = model.latestPhotoImportFlows
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
            for activity in Activity<PhotoRunActivityAttributes>.activities {
                let runID = activity.attributes.runId
                if let latest = flows.first(where: { $0.session.runID == runID }),
                    activityBatches[activity.id] != latest.liveActivityBatchID
                {
                    continue
                }
                guard
                    !model.photoImportFlows.contains(where: {
                        $0.session.runID == runID && $0.session.progress.remaining > 0
                    })
                else { continue }
                do {
                    let lifecycle = try await model.client.photoRunReview(.init(runId: runID)).lifecycle
                    let phase = lifecycle.phase.rawValue
                    let terminal = ["ready_for_review", "ready_for_handoff", "completed"].contains(phase)
                    let state = PhotoRunActivityAttributes.ContentState(
                        phase: phase, title: terminal ? "Photo import ready" : "Processing photos",
                        detail: lifecycle.dispatchError
                            ?? "Described \(lifecycle.describedImageCount) of \(lifecycle.finalizedImageCount)",
                        completed: lifecycle.describedImageCount, total: lifecycle.finalizedImageCount,
                        needsAttention: phase == "needs_attention")
                    if terminal {
                        await activity.end(
                            ActivityContent(state: state, staleDate: nil), dismissalPolicy: .default)
                        tokenTasks.removeValue(forKey: runID)?.cancel()
                        trackedActivities.removeValue(forKey: runID)
                        _ = try await model.client.endPhotoRunLiveActivity(.init(runId: runID))
                    } else if lastStates[runID] != state {
                        await Self.updateActivity(activity.id, state: state)
                    }
                    lastStates[runID] = state
                } catch { Diagnostics.report(error, context: "photos.import.liveActivity.refresh") }
            }
        }
        for flow in flows {
            guard let runID = flow.session.runID else { continue }
            let batchID = flow.liveActivityBatchID
            let ownedActivityIDs = Set(activityBatches.filter { $0.value == batchID }.map(\.key))
            let progress = flow.session.progress
            let uploading = progress.uploaded < progress.total
            guard flow.isBusy || flow.session.phase == .complete || flow.needsAttention else { continue }
            let state = PhotoRunActivityAttributes.ContentState(
                phase: flow.needsAttention ? "needs_attention" : (uploading ? "uploading" : "describing"),
                title: flow.needsAttention ? "Photo import needs attention" : "Importing photos",
                detail: progress.waitingReason
                    ?? (uploading
                        ? "Transferred \(progress.transferred) of \(progress.total)"
                        : "Photos imported; processing continues"),
                completed: progress.transferred, total: progress.total, needsAttention: flow.needsAttention)
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
                guard foreground, uploading, !startedBatches.contains(flow.liveActivityBatchID),
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
    nonisolated private static func updateActivity(
        _ id: String, state: PhotoRunActivityAttributes.ContentState
    ) async {
        guard let activity = Activity<PhotoRunActivityAttributes>.activities.first(where: { $0.id == id })
        else { return }
        await activity.update(ActivityContent(state: state, staleDate: nil))
    }

}
