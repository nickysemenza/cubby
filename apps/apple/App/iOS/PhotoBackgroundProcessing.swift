import BackgroundTasks
import CubbyKit
import Foundation

/// iOS grants this work opportunistically. The SQLite match cache is the checkpoint, so an
/// expiration or process death loses at most the current 32-photo batch.
@MainActor
enum PhotoBackgroundProcessing {
    static let identifier = "com.nickysemenza.cubby.photo-matching"

    static func register() {
        BGTaskScheduler.shared.register(forTaskWithIdentifier: identifier, using: nil) { task in
            guard let task = task as? BGProcessingTask else { return }
            Task { @MainActor in await handle(task) }
        }
    }

    static func scheduleIfNeeded(model: AppModel) {
        guard model.phase == .signedIn, model.participation.automaticWork,
            (model.photoLibrary.hasPendingMatching || model.photoLibrary.isLoadingLibrary)
        else { return }
        // At most one pending request for the resumable scan.
        BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: identifier)
        let request = BGProcessingTaskRequest(identifier: identifier)
        request.requiresNetworkConnectivity = true
        do {
            try BGTaskScheduler.shared.submit(request)
        } catch {
            Diagnostics.report(error, context: "photos.background.schedule")
        }
    }

    static func cancel() {
        BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: identifier)
    }

    private static func handle(_ task: BGProcessingTask) async {
        guard let model = AppModel.active else {
            task.setTaskCompleted(success: false)
            return
        }
        if model.phase == .restoring { await model.restoreSession() }
        guard model.phase == .signedIn, model.participation.automaticWork else {
            task.setTaskCompleted(success: true)
            return
        }
        let checkedBefore = model.photoLibrary.checked.count
        let worker = Task { @MainActor in
            await model.startAutomaticPhotoMatching()
            await model.photoLibrary.waitForMatching()
        }
        task.expirationHandler = {
            worker.cancel()
            Task { @MainActor in model.photoLibrary.interruptMatching() }
        }
        await worker.value
        if worker.isCancelled { model.photoLibrary.interruptMatching() }
        task.expirationHandler = nil
        task.setTaskCompleted(success: !worker.isCancelled)
        // Avoid repeatedly relaunching for photos that failed without making progress.
        if model.photoLibrary.hasPendingMatching,
            (worker.isCancelled || model.photoLibrary.checked.count > checkedBefore)
        {
            scheduleIfNeeded(model: model)
        }
    }
}
