import ArgumentParser
import CubbyKit
import Foundation

/// Drives the app's historical-impact review session against an isolated fixture server.
struct HeadlessSpendingClassification: AsyncParsableCommand {
    static let configuration = CommandConfiguration(commandName: "headless-spending-classification")

    @Option(name: .customLong("base-url")) var baseURLString: String
    @Option(name: .customLong("input-file")) var inputFile: String?
    @Option(name: .customLong("review-file")) var reviewFile: String?

    @MainActor
    func run() async throws {
        try await CLI.run {
            guard (inputFile == nil) != (reviewFile == nil) else {
                throw CLIError.message("Choose an input to preview or an exact reviewed preview to apply")
            }
            let context = try await CLI.fixtureContext(baseURLString: baseURLString)
            let data = try Data(contentsOf: URL(fileURLWithPath: inputFile ?? reviewFile!))
            let decoder = JSONDecoder.cubby()
            let output: Data
            if reviewFile != nil {
                let reviewed = try decoder.decode(SpendingClassificationReviewPreview.self, from: data)
                let session = SpendingClassificationReviewSession(reviewed: reviewed)
                try await session.apply(client: context.client)
                output = try JSONEncoder.cubby().encode(["applied": session.applied])
            } else {
                let session = SpendingClassificationReviewSession()
                try await session.prepare(
                    decoder.decode(SpendingClassificationReviewInputRequest.self, from: data),
                    client: context.client)
                output = try JSONEncoder.cubby().encode(session.preview)
            }
            print(String(decoding: output, as: UTF8.self))
        }
    }
}
