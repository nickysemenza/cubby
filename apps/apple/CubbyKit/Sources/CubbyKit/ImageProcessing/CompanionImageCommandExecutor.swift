import Foundation

public struct CompanionImageCommandExecutor: Sendable {
    private enum DeadlineFailure: Error { case exceeded }

    private let processor: CompanionImageProcessor
    private let describer: any CompanionImageDescribing

    public init(
        processor: CompanionImageProcessor = CompanionImageProcessor(),
        describer: any CompanionImageDescribing = FoundationModelsImageDescriber()
    ) {
        self.processor = processor
        self.describer = describer
    }

    public func execute(_ command: ImageProcessingCommand) async -> ImageProcessingResult {
        let outcome: ImageProcessingResult.OutcomePayload
        do {
            guard command.companionDeadline > .now else {
                return result(
                    for: command,
                    outcome: failed(kind(command), retryable: false, reason: "deadline_exceeded"))
            }
            outcome = try await executeBeforeDeadline(command)
        } catch DeadlineFailure.exceeded {
            outcome = failed(kind(command), retryable: false, reason: "deadline_exceeded")
        } catch is CancellationError {
            outcome = failed(kind(command), retryable: true, reason: "cancelled")
        } catch let error as CompanionImageProcessor.Failure {
            outcome = failed(kind(command), retryable: false, reason: reason(error))
        } catch is PhotoFile.Failure {
            outcome = skipped(kind(command), reason: .unsupportedFormat)
        } catch CompanionImageDescriptionFailure.unavailable {
            outcome = failed(.describeImage, retryable: true, reason: "model_unavailable")
        } catch let error as URLError {
            outcome = failed(kind(command), retryable: true, reason: "network_\(error.code.rawValue)")
        } catch {
            outcome = failed(kind(command), retryable: true, reason: "processing_failed")
        }
        return result(for: command, outcome: outcome)
    }

    private func executeBeforeDeadline(
        _ command: ImageProcessingCommand
    ) async throws -> ImageProcessingResult.OutcomePayload {
        let interval = command.companionDeadline.timeIntervalSinceNow
        guard interval > 0 else { throw DeadlineFailure.exceeded }
        return try await withThrowingTaskGroup(
            of: ImageProcessingResult.OutcomePayload.self
        ) { group in
            group.addTask {
                switch command {
                case .subjectLift(let value): try await executeSubjectLift(value)
                case .describeImage(let value): try await executeDescription(value)
                }
            }
            group.addTask {
                try await Task.sleep(for: .seconds(interval))
                throw DeadlineFailure.exceeded
            }
            guard let first = try await group.next() else { throw CancellationError() }
            group.cancelAll()
            return first
        }
    }

    private func executeSubjectLift(
        _ command: ImageProcessingCommandSubjectLift
    ) async throws -> ImageProcessingResult.OutcomePayload {
        guard let sourceURL = URL(string: command.source.url) else { throw URLError(.badURL) }
        let source = CompanionImageSource(
            url: sourceURL, sha256: command.source.sha256,
            contentType: command.source.contentType.rawValue)
        guard let uploadURL = URL(string: command.output.uploadUrl) else {
            return failed(.subjectLift, retryable: false, reason: "invalid_upload_url")
        }
        let result = try await processor.makeTransparentCutout(
            source: source,
            output: CompanionImageOutput(
                uploadURL: uploadURL, contentType: command.output.contentType.rawValue))
        guard command.deadline > .now else {
            return failed(.subjectLift, retryable: false, reason: "deadline_exceeded")
        }
        switch result {
        case .completed(let artifact):
            return .init(
                value1: .subjectLift(
                    .init(
                        kind: .subjectLift, status: .completed, sha256: artifact.sha256,
                        contentType: .imagePng, width: artifact.width, height: artifact.height)))
        case .noSubject:
            return skipped(.subjectLift, reason: .noSubject)
        case .unsupportedFormat:
            return skipped(.subjectLift, reason: .unsupportedFormat)
        }
    }

    private func executeDescription(
        _ command: ImageProcessingCommandDescribeImage
    ) async throws -> ImageProcessingResult.OutcomePayload {
        guard describer.availability() == .available else {
            return failed(.describeImage, retryable: true, reason: "model_unavailable")
        }
        guard let sourceURL = URL(string: command.source.url) else { throw URLError(.badURL) }
        let image = try await processor.sourceImage(
            CompanionImageSource(
                url: sourceURL, sha256: command.source.sha256,
                contentType: command.source.contentType.rawValue))
        let description = try await describer.describe(image)
        guard command.deadline > .now else {
            return failed(.describeImage, retryable: false, reason: "deadline_exceeded")
        }
        let eligibility: ImageCutoutEligibility =
            switch description.cutoutEligibility {
            case .eligible: .eligible
            case .ineligible: .ineligible
            case .review: .review
            }
        #if os(macOS)
            let platform: ImageProcessingCompletedOutcomeDescribeImage.RuntimePayload.PlatformPayload =
                .macos
        #else
            let platform: ImageProcessingCompletedOutcomeDescribeImage.RuntimePayload.PlatformPayload =
                .ios
        #endif
        return .init(
            value1: .describeImage(
                .init(
                    kind: .describeImage,
                    status: .completed,
                    description: .init(
                        description: description.description,
                        cutoutEligibility: eligibility,
                        claims: description.claims.map {
                            .init(text: $0.text, evidenceKind: .visual)
                        }),
                    runtime: .init(
                        platform: platform,
                        osVersion: ProcessInfo.processInfo.operatingSystemVersionString,
                        model: "SystemLanguageModel.default"))))
    }

    private func result(
        for command: ImageProcessingCommand, outcome: ImageProcessingResult.OutcomePayload
    ) -> ImageProcessingResult {
        ImageProcessingResult(
            jobId: command.companionJobID,
            attemptId: command.companionAttemptID,
            completedAt: .now,
            outcome: outcome)
    }

    private func kind(_ command: ImageProcessingCommand) -> ImageProcessingJobKind {
        switch command {
        case .subjectLift: .subjectLift
        case .describeImage: .describeImage
        }
    }

    private func skipped(
        _ kind: ImageProcessingJobKind, reason: ImageProcessingSkippedOutcome.ReasonPayload
    ) -> ImageProcessingResult.OutcomePayload {
        .init(value2: .init(kind: kind, status: .skipped, reason: reason))
    }

    private func failed(
        _ kind: ImageProcessingJobKind, retryable: Bool, reason: String
    ) -> ImageProcessingResult.OutcomePayload {
        .init(
            value3: .init(
                kind: kind, status: .failed, retryable: retryable,
                reason: String(reason.prefix(240))))
    }

    private func reason(_ error: CompanionImageProcessor.Failure) -> String {
        switch error {
        case .insecureTransferURL: "insecure_transfer_url"
        case .sourceTooLarge: "source_too_large"
        case .sourceChecksumMismatch: "source_checksum_mismatch"
        case .unsupportedOutputContentType: "unsupported_output_content_type"
        }
    }
}
