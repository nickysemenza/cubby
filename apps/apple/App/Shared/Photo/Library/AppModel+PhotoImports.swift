import CubbyKit
import Foundation

extension AppModel {
    private var photoImportDirectory: URL {
        URL.applicationSupportDirectory.appendingPathComponent("Cubby/photo-imports", isDirectory: true)
            .appendingPathComponent(baseURL.absoluteString.data(using: .utf8)!.sha256Hex, isDirectory: true)
    }

    var latestPhotoImportFlows: [PhotoImportRunFlow] {
        photoImportFlows.filter { flow in
            guard let runID = flow.session.runID else { return true }
            return photoImportFlows.last(where: { $0.session.runID == runID }) === flow
        }
    }

    var hasPendingPhotoImports: Bool { photoImportFlows.contains { $0.hasPendingWork } }

    func makePhotoImportFlow() -> PhotoImportRunFlow {
        let flow = PhotoImportRunFlow(
            client: client, activityCenter: backgroundActivity,
            checkpointURL: photoImportDirectory.appendingPathComponent("\(UUID().uuidString).json"))
        photoImportFlows.append(flow)
        return flow
    }

    func recoverPhotoImports() {
        do {
            for url in try PhotoImportRunCheckpoint.journals(in: photoImportDirectory) {
                let existing = photoImportFlows.first {
                    $0.liveActivityBatchID == url.deletingPathExtension().lastPathComponent
                }
                let flow = PhotoImportRunFlow(
                    client: client, activityCenter: backgroundActivity, checkpointURL: url)
                do {
                    let state = try JSONDecoder().decode(
                        PhotoImportRunCheckpoint.self, from: Data(contentsOf: url))
                    if state.needsCancellationSettlement {
                        guard existing?.session.hasActiveWork != true else { continue }
                        let client = client
                        Task {
                            do {
                                try await PhotoImportRunUploader(client: client, checkpointURL: url)
                                    .settleCancellation()
                            } catch { Diagnostics.report(error, context: "photos.import.settleCancellation") }
                        }
                    } else if state.shouldResume {
                        guard existing == nil else { continue }
                        try flow.recover(from: url)
                        photoImportFlows.append(flow)
                    }
                } catch {
                    if existing == nil {
                        flow.noteRecoveryFailure(error)
                        photoImportFlows.append(flow)
                    }
                    Diagnostics.report(error, context: "photos.import.recover")
                }
            }
            if FileManager.default.fileExists(atPath: photoImportDirectory.path) {
                let selections = try FileManager.default.contentsOfDirectory(
                    at: photoImportDirectory, includingPropertiesForKeys: nil
                ).filter { $0.pathExtension == "selection" }
                for url in selections {
                    let checkpoint = url.deletingPathExtension().appendingPathExtension("json")
                    guard !FileManager.default.fileExists(atPath: checkpoint.path),
                        !photoImportFlows.contains(where: {
                            $0.liveActivityBatchID == checkpoint.deletingPathExtension().lastPathComponent
                        })
                    else { continue }
                    let flow = PhotoImportRunFlow(
                        client: client, activityCenter: backgroundActivity, checkpointURL: checkpoint)
                    photoImportFlows.append(flow)
                    Task {
                        do { try await flow.recoverSelection(from: url) } catch {
                            flow.noteRecoveryFailure(error)
                            Diagnostics.report(error, context: "photos.import.recoverSelection")
                        }
                    }
                }
            }
        } catch {
            Diagnostics.report(error, context: "photos.import.recover")
        }
    }

    func retirePhotoImport(_ flow: PhotoImportRunFlow) {
        Task {
            await flow.session.waitUntilIdle()
            let importedIDs = flow.session.importedPhotoIDs
            photoLibrary.selectedIDs.removeAll { importedIDs.contains($0) }
            if flow.session.phase == .cancelled {
                photoImportFlows.removeAll { $0 === flow }
                return
            }
            guard flow.session.phase == .complete, flow.session.progress.failedIDs.isEmpty else { return }
            guard let runID = flow.session.runID else { return }
            do {
                let phase = try await client.photoRunReview(.init(runId: runID)).lifecycle.phase.rawValue
                if ["ready_for_review", "ready_for_handoff", "completed"].contains(phase) {
                    photoImportFlows.removeAll { $0 === flow }
                }
            } catch { Diagnostics.report(error, context: "photos.import.retire") }
        }
    }

    func continuePhotoImports() {
        guard phase == .signedIn else { return }
        recoverPhotoImports()
        for flow in photoImportFlows { flow.continueAutomatically() }
    }

    func waitForPhotoImports() async {
        for flow in photoImportFlows { await flow.session.waitUntilIdle() }
    }

    func interruptPhotoImports() {
        for flow in photoImportFlows { flow.interrupt() }
    }
}
