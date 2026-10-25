import BackgroundTasks
import CubbyKit
import Foundation
import Observation

/// Both system windows use the companion's shared slots, outbox and cancellation path.
@MainActor
@Observable
final class ImageQueueBackgroundProcessing {
    static let shared = ImageQueueBackgroundProcessing()
    static let overnightIdentifier = "com.nickysemenza.cubby.image-queue"
    private(set) var isRunning = false

    static func register() {
        BGTaskScheduler.shared.register(forTaskWithIdentifier: overnightIdentifier, using: .main) { task in
            guard let task = task as? BGProcessingTask else { return }
            Task { @MainActor in await shared.handle(task) }
        }
    }

    static func scheduleIfNeeded(model: AppModel, earliestBeginDate: Date? = nil) {
        guard model.phase == .signedIn, model.participation.automaticWork else {
            BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: overnightIdentifier)
            return
        }
        let request = BGProcessingTaskRequest(identifier: overnightIdentifier)
        request.earliestBeginDate = earliestBeginDate
        request.requiresExternalPower = true
        request.requiresNetworkConnectivity = true
        do { try BGTaskScheduler.shared.submit(request) } catch {
            Diagnostics.report(error, context: "images.background.schedule")
        }
    }

    @available(iOS 26.0, *)
    func processNow(model: AppModel) {
        guard !isRunning, model.phase == .signedIn, model.participation.automaticWork else { return }
        let identifier = "com.nickysemenza.cubby.image-queue.continued.\(UUID().uuidString)"
        // A unique identifier per member action avoids duplicate handler registration.
        BGTaskScheduler.shared.register(forTaskWithIdentifier: identifier, using: .main) { task in
            guard let task = task as? BGContinuedProcessingTask else { return }
            Task { @MainActor in await self.handle(task) }
        }
        let request = BGContinuedProcessingTaskRequest(
            identifier: identifier, title: "Process image queue", subtitle: "Starting image work…")
        request.strategy = .fail
        if BGTaskScheduler.supportedResources.contains(.gpu) { request.requiredResources = .gpu }
        isRunning = true
        do { try BGTaskScheduler.shared.submit(request) } catch {
            isRunning = false
            model.handle(error)
        }
    }

    private func handle(_ task: BGTask) async {
        let continued: Bool
        if #available(iOS 26.0, *) {
            continued = task is BGContinuedProcessingTask
        } else {
            continued = false
        }
        guard !isRunning || continued, let model = AppModel.active
        else {
            task.setTaskCompleted(success: false)
            return
        }
        isRunning = true
        defer { isRunning = false }
        if #available(iOS 26.0, *), let continued = task as? BGContinuedProcessingTask {
            continued.progress.totalUnitCount = 1
            continued.progress.completedUnitCount = 0
        }
        let worker = Task { @MainActor in
            if model.phase == .restoring { await model.restoreSession() }
            guard model.phase == .signedIn, model.participation.automaticWork else { return false }
            return await model.runCompanionJobsInBackground { processed, total in
                if #available(iOS 26.0, *), let continued = task as? BGContinuedProcessingTask {
                    // Until the queue is empty there may be another batch to discover.
                    continued.progress.totalUnitCount = Int64(max(total, processed + 1))
                    continued.progress.completedUnitCount = Int64(processed)
                    continued.updateTitle("Process image queue", subtitle: "Processed \(processed) images")
                }
            }
        }
        task.expirationHandler = {
            worker.cancel()
        }
        let more = await worker.value
        task.expirationHandler = nil
        if #available(iOS 26.0, *), let continued = task as? BGContinuedProcessingTask,
            !worker.isCancelled, !more
        {
            continued.progress.completedUnitCount = continued.progress.totalUnitCount
        }
        task.setTaskCompleted(success: !worker.isCancelled && !more)
        Self.scheduleIfNeeded(
            model: model, earliestBeginDate: Date.now.addingTimeInterval(more ? 3600 : 12 * 3600))
    }
}
