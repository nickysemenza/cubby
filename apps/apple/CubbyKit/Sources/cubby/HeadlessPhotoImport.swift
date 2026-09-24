import ArgumentParser
import CubbyKit
import Foundation

/// Exercises the native photo-run uploader against the disposable Worker and object store.
struct HeadlessPhotoImport: AsyncParsableCommand {
    static let configuration = CommandConfiguration(commandName: "headless-photo-import")

    @Option(name: .customLong("base-url")) var baseURLString: String
    @Argument(help: "Synthetic image paths to upload in order.") var paths: [String]

    func run() async throws {
        try await CLI.run {
            guard
                let baseURL = URL(string: baseURLString),
                baseURL.scheme == "http", baseURL.host() == "127.0.0.1",
                baseURL.port != nil, baseURL.user() == nil, baseURL.password() == nil,
                baseURL.path().isEmpty || baseURL.path() == "/"
            else {
                throw CLIError.message("Headless photo import requires a loopback HTTP server")
            }
            guard !paths.isEmpty else {
                throw CLIError.message("Headless photo import requires image paths")
            }

            let credentials = CredentialProvider(
                host: CubbyBaseURL.host(of: baseURL), store: InMemorySessionTokenStore())
            let identity = ClientIdentity.currentApp(product: "cubby-cli", installationID: nil)
            let auth = AuthFlow(baseURL: baseURL, credentials: credentials, identity: identity)
            _ = try await auth.signIn(
                email: "sim@cubby.localhost", password: "cubby-sim-local-only")
            let client = CubbyClient(
                baseURL: baseURL, credentials: credentials, identity: identity)
            let photos = try paths.enumerated().map { index, path in
                let file = try PhotoFile.importing(URL(fileURLWithPath: path))
                return PhotoImportRunPhoto(
                    id: "synthetic-\(index)", file: file,
                    provenance: PhotoAnalysisProvenance(
                        source: .files, filename: file.filename))
            }
            let uploader = PhotoImportRunUploader(client: client)
            let runID = try await uploader.upload(
                photos,
                createRun: PhotoImportCreateRunInput(
                    ledgerPartyId: nil, notes: "Synthetic photo import rehearsal"))
            let progress = await uploader.progress
            guard progress.uploaded == photos.count else {
                throw CLIError.message("Native uploader did not finalize every photo")
            }
            print("Headless native photo import verified: \(runID)")
        }
    }
}
