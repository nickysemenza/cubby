import ArgumentParser
import CubbyKit
import Foundation

/// Exercises the native photo-run uploader against the disposable Worker and object store.
struct HeadlessPhotoImport: AsyncParsableCommand {
    static let configuration = CommandConfiguration(commandName: "headless-photo-import")

    @Option(name: .customLong("base-url")) var baseURLString: String
    @Argument(help: "Synthetic image paths to upload in order.") var paths: [String]

    @MainActor
    func run() async throws {
        try await CLI.run {
            let startedAt = Date.now
            guard !paths.isEmpty else {
                throw CLIError.message("Headless photo import requires image paths")
            }

            let context = try await CLI.fixtureContext(baseURLString: baseURLString)
            print(
                "Headless photo phase: signed in after \(Int(Date.now.timeIntervalSince(startedAt) * 1000))ms"
            )
            let client = context.client
            let photos = try paths.enumerated().map { index, path in
                let file = try PhotoFile.importing(URL(fileURLWithPath: path))
                return PhotoImportRunPhoto(
                    id: "synthetic-\(index)", file: file,
                    provenance: PhotoAnalysisProvenance(
                        source: .files, filename: file.filename))
            }
            print(
                "Headless photo phase: files loaded after \(Int(Date.now.timeIntervalSince(startedAt) * 1000))ms"
            )
            let uploader = PhotoImportRunUploader(client: client)
            let runID = try await uploader.upload(
                photos,
                createRun: PhotoImportCreateRunInput(
                    ledgerPartyId: nil, notes: "Synthetic photo import rehearsal"),
                performLocalAnalysis: false,
                progress: { progress in
                    print(
                        "Headless photo progress: \(progress.uploaded) uploaded, \(progress.analyzed) analyzed after \(Int(Date.now.timeIntervalSince(startedAt) * 1000))ms"
                    )
                })
            let progress = await uploader.progress
            guard progress.uploaded == photos.count else {
                throw CLIError.message("Native uploader did not finalize every photo")
            }
            let review = RunReviewSession()
            await review.refresh(runID: runID, client: client)
            if let error = review.error { throw CLIError.message(error) }
            print("Headless native photo import verified: \(runID)")
        }
    }
}
