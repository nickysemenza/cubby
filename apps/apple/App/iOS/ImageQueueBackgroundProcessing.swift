import BackgroundTasks
import CubbyKit
import Foundation

/// The overnight charging window uses the companion's shared slots, outbox and cancellation path.
@MainActor
final class ImageQueueBackgroundProcessing {
    static let shared = ImageQueueBackgroundProcessing()
    static let overnightIdentifier = "com.nickysemenza.cubby.image-queue"
    private var isRunning = false

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

    private func handle(_ task: BGTask) async {
        guard !isRunning, let model = AppModel.active else {
            task.setTaskCompleted(success: false)
            return
        }
        isRunning = true
        defer { isRunning = false }
        let worker = Task { @MainActor in
            if model.phase == .restoring { await model.restoreSession() }
            guard model.phase == .signedIn, model.participation.automaticWork else { return false }
            return await model.runCompanionJobsInBackground()
        }
        task.expirationHandler = {
            worker.cancel()
        }
        let more = await worker.value
        task.expirationHandler = nil
        task.setTaskCompleted(success: !worker.isCancelled && !more)
        Self.scheduleIfNeeded(
            model: model, earliestBeginDate: Date.now.addingTimeInterval(more ? 3600 : 12 * 3600))
    }
}
