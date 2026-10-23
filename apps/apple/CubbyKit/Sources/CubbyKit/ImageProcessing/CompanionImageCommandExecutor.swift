import Foundation

public struct CompanionImageCommandExecutor: Sendable {
    private enum DeadlineFailure: Error { case exceeded }
    private struct Execution: Sendable {
        let outcome: ImageProcessingResultOutcome
        let diagnostics: CompanionImageDiagnostics
    }

    private let processor: CompanionImageProcessor
    private let describer: any CompanionImageDescribing

    public init(
        processor: CompanionImageProcessor = CompanionImageProcessor(),
        describer: any CompanionImageDescribing = FoundationModelsImageDescriber()
    ) {
        self.processor = processor
        self.describer = describer
    }

    public func execute(_ command: ImageProcessingCommand) async throws -> ImageProcessingResult {
        let metadata = try CompanionImageCommandMetadata(command)
        let execution: Execution
        let started = ContinuousClock.now
        do {
            guard metadata.deadline > .now else {
                return result(
                    for: metadata,
                    outcome: failed(metadata.jobKind, retryable: false, reason: "deadline_exceeded"),
                    diagnostics: .init(processingMilliseconds: 0))
            }
            execution = try await executeBeforeDeadline(command)
        } catch DeadlineFailure.exceeded {
            execution = failureExecution(metadata, "deadline_exceeded", false, started)
        } catch is CancellationError {
            execution = failureExecution(metadata, "cancelled", true, started)
        } catch let error as CompanionImageProcessor.Failure {
            execution = failureExecution(metadata, reason(error), false, started)
        } catch is PhotoFile.Failure {
            execution = .init(
                outcome: skipped(metadata.jobKind, reason: .unsupportedFormat),
                diagnostics: .init(processingMilliseconds: milliseconds(since: started)))
        } catch CompanionImageDescriptionFailure.unavailable {
            execution = failureExecution(metadata, "model_unavailable", true, started)
        } catch CompanionImageDescriptionFailure.model(let reason, let retryable) {
            execution = failureExecution(metadata, reason, retryable, started)
        } catch let error as URLError {
            execution = failureExecution(metadata, "network_\(error.code.rawValue)", true, started)
        } catch {
            execution = failureExecution(
                metadata, "processing_failed: \(String(reflecting: error))", true, started)
        }
        return result(
            for: metadata, outcome: execution.outcome, diagnostics: execution.diagnostics)
    }

    private func executeBeforeDeadline(
        _ command: ImageProcessingCommand
    ) async throws -> Execution {
        let metadata = try CompanionImageCommandMetadata(command)
        let interval = metadata.deadline.timeIntervalSinceNow
        guard interval > 0 else { throw DeadlineFailure.exceeded }
        return try await withThrowingTaskGroup(
            of: Execution.self
        ) { group in
            group.addTask {
                switch command {
                case .subjectLift(let value): try await executeSubjectLift(value)
                case .describeImage(let value): try await executeDescription(value)
                case .unrecognized(let raw):
                    throw UnsupportedNativeResponse(context: "image-processing command", raw: raw)
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
    ) async throws -> Execution {
        guard let sourceURL = URL(string: command.source.url) else { throw URLError(.badURL) }
        let source = CompanionImageSource(
            url: sourceURL, sha256: command.source.sha256,
            contentType: command.source.contentType.rawValue)
        guard let uploadURL = URL(string: command.output.uploadUrl) else {
            return .init(
                outcome: failed(.subjectLift, retryable: false, reason: "invalid_upload_url"),
                diagnostics: .init())
        }
        let result = try await processor.makeTransparentCutout(
            source: source,
            output: CompanionImageOutput(
                uploadURL: uploadURL, contentType: command.output.contentType.rawValue))
        guard command.deadline > .now else {
            return .init(
                outcome: failed(.subjectLift, retryable: false, reason: "deadline_exceeded"),
                diagnostics: .init())
        }
        switch result {
        case .completed(let artifact):
            return .init(
                outcome: .completed(
                    .subjectLift(
                        .init(
                            kind: .subjectLift, status: .completed, sha256: artifact.sha256,
                            contentType: .imagePng, width: artifact.width, height: artifact.height))),
                diagnostics: artifact.diagnostics)
        case .alreadyTransparent:
            return .init(outcome: skipped(.subjectLift, reason: .notSuitable), diagnostics: .init())
        case .noSubject:
            return .init(outcome: skipped(.subjectLift, reason: .noSubject), diagnostics: .init())
        case .unsupportedFormat:
            return .init(
                outcome: skipped(.subjectLift, reason: .unsupportedFormat), diagnostics: .init())
        }
    }

    private func executeDescription(
        _ command: ImageProcessingCommandDescribeImage
    ) async throws -> Execution {
        if let output = command.analysisOutput {
            guard let sourceURL = URL(string: command.source.url),
                let uploadURL = URL(string: output.uploadUrl)
            else { throw URLError(.badURL) }
            let artifact = try await processor.makeAnalysisJPEG(
                source: .init(
                    url: sourceURL, sha256: command.source.sha256,
                    contentType: command.source.contentType.rawValue),
                output: .init(uploadURL: uploadURL, contentType: output.contentType.rawValue))
            guard command.deadline > .now else {
                return .init(
                    outcome: failed(.describeImage, retryable: false, reason: "deadline_exceeded"),
                    diagnostics: artifact.diagnostics)
            }
            return .init(
                outcome: .normalized(
                    .init(
                        kind: .describeImage, status: .normalized,
                        key: output.key, sha256: artifact.sha256,
                        contentType: .imageJpeg, width: artifact.width, height: artifact.height)),
                diagnostics: artifact.diagnostics)
        }
        guard describer.availability() == .available else {
            return .init(
                outcome: failed(.describeImage, retryable: true, reason: "model_unavailable"),
                diagnostics: .init())
        }
        guard let sourceURL = URL(string: command.source.url) else { throw URLError(.badURL) }
        let decoded = try await processor.decodedSourceImage(
            CompanionImageSource(
                url: sourceURL, sha256: command.source.sha256,
                contentType: command.source.contentType.rawValue))
        let processingStarted = ContinuousClock.now
        let description = try await describer.describe(decoded.image)
        var diagnostics = decoded.diagnostics
        diagnostics.processingMilliseconds = milliseconds(since: processingStarted)
        guard command.deadline > .now else {
            return .init(
                outcome: failed(.describeImage, retryable: false, reason: "deadline_exceeded"),
                diagnostics: diagnostics)
        }
        let eligibility: ImageCutoutEligibility =
            switch description.cutoutEligibility {
            case .eligible: .eligible
            case .ineligible: .ineligible
            case .review: .review
            }
        #if os(macOS)
            let platform: ImageProcessingCompletedOutcomeDescribeImageRuntimePlatform =
                .macos
        #else
            let platform: ImageProcessingCompletedOutcomeDescribeImageRuntimePlatform =
                .ios
        #endif
        return .init(
            outcome: .completed(
                .describeImage(
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
                            model: "SystemLanguageModel.default")))),
            diagnostics: diagnostics)
    }

    private func result(
        for metadata: CompanionImageCommandMetadata, outcome: ImageProcessingResultOutcome,
        diagnostics: CompanionImageDiagnostics
    ) -> ImageProcessingResult {
        ImageProcessingResult(
            diagnostics: .init(
                osVersion: ProcessInfo.processInfo.operatingSystemVersionString,
                appVersion: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString")
                    as? String,
                processor: metadata.processor, decodeMs: diagnostics.decodeMilliseconds,
                processingMs: diagnostics.processingMilliseconds,
                uploadMs: diagnostics.uploadMilliseconds, width: diagnostics.width,
                height: diagnostics.height, orientation: diagnostics.orientation),
            jobId: metadata.jobID,
            attemptId: metadata.attemptID,
            completedAt: .now,
            outcome: outcome)
    }

    private func failureExecution(
        _ metadata: CompanionImageCommandMetadata, _ reason: String, _ retryable: Bool,
        _ started: ContinuousClock.Instant
    ) -> Execution {
        .init(
            outcome: failed(metadata.jobKind, retryable: retryable, reason: reason),
            diagnostics: .init(processingMilliseconds: milliseconds(since: started)))
    }

    private func milliseconds(since start: ContinuousClock.Instant) -> Double {
        let components = start.duration(to: .now).components
        return Double(components.seconds) * 1_000
            + Double(components.attoseconds) / 1_000_000_000_000_000
    }

    private func skipped(
        _ kind: ImageProcessingJobKind, reason: ImageProcessingSkippedOutcomeReason
    ) -> ImageProcessingResultOutcome {
        .skipped(.init(kind: kind, status: .skipped, reason: reason))
    }

    private func failed(
        _ kind: ImageProcessingJobKind, retryable: Bool, reason: String
    ) -> ImageProcessingResultOutcome {
        .failed(
            .init(
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
