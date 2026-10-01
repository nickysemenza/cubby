import ArgumentParser
import CubbyKit
import Foundation

/// Exercises the app's review session against an explicitly selected disposable fixture.
struct RunReviewCommand: AsyncParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "run-review",
        abstract: "Read a fixture Run review, or explicitly submit its saved reviewed commands.")

    @Option(name: .customLong("base-url")) var baseURLString: String
    @Argument(help: "Run to review on the loopback fixture server.") var runID: String
    @Option(name: .customLong("save-review")) var saveReview: String?
    @Option(name: .customLong("review-file")) var reviewFile: String?
    @Option(name: .customLong("approve-group")) var approveGroups: [String] = []
    @Option(name: .customLong("discard-group")) var discardGroup: String?
    @Option(name: .customLong("apply-finding")) var applyFinding: String?
    @Option(name: .customLong("dismiss-finding")) var dismissFinding: String?
    @Option(name: .customLong("reviewed-fingerprint")) var reviewedFingerprint: String?
    @Flag(name: .customLong("start-grouping")) var startGrouping = false

    @MainActor
    func run() async throws {
        try await CLI.run {
            let actionCount = [
                !approveGroups.isEmpty, discardGroup != nil, applyFinding != nil,
                dismissFinding != nil, startGrouping,
            ].filter { $0 }.count
            guard actionCount <= 1 else {
                throw CLIError.message("Choose one explicit review action per invocation")
            }
            let needsReview = !approveGroups.isEmpty || applyFinding != nil || dismissFinding != nil
            guard !needsReview || reviewFile != nil else {
                throw CLIError.message("Approval and finding commands require --review-file")
            }
            guard reviewedFingerprint == nil || applyFinding != nil else {
                throw CLIError.message("--reviewed-fingerprint belongs to --apply-finding")
            }
            guard applyFinding == nil || reviewedFingerprint != nil else {
                throw CLIError.message("Applying a finding requires its explicit --reviewed-fingerprint")
            }

            let reviewed = try reviewFile.map { path in
                try JSONDecoder.cubby().decode(
                    RunReviewDocument.self, from: Data(contentsOf: URL(fileURLWithPath: path)))
            }
            let context = try await CLI.fixtureContext(baseURLString: baseURLString)
            let session = RunReviewSession(
                snapshot: reviewed?.snapshot, review: reviewed?.review,
                reportDiagnostic: { error, diagnosticContext in
                    CLI.printError("\(diagnosticContext): \(error.localizedDescription)")
                })
            let action: RunReviewAction?
            if !approveGroups.isEmpty, let reviewed {
                action = .approvePhotoGroups(reviewed: reviewed, groupKeys: approveGroups)
            } else if let id = applyFinding ?? dismissFinding, let reviewed {
                action = .resolveFinding(
                    reviewed: reviewed, id: id, apply: applyFinding != nil,
                    reviewedFingerprint: reviewedFingerprint)
            } else if let discardGroup {
                action = .discardPhotoGroup(groupKey: discardGroup)
            } else if startGrouping {
                action = .startGrouping
            } else {
                action = nil
            }
            if let action {
                guard await session.execute(action, runID: runID, client: context.client) else {
                    throw CLIError.message(session.actionError ?? "Another review command is still running")
                }
            } else {
                await session.refresh(runID: runID, client: context.client)
            }
            if let error = session.error { throw CLIError.message(error) }
            let output = try JSONEncoder.cubby().encode(session.document(runID: runID))
            if let saveReview {
                try output.write(to: URL(fileURLWithPath: saveReview), options: .atomic)
            }
            print(String(decoding: output, as: UTF8.self))
        }
    }
}
