import Foundation

public enum CompanionImageProcessingProtocol {
    public static let version = 1

    public static func attemptKey(jobID: String, attemptID: String) -> String {
        "\(jobID):\(attemptID)"
    }
}

extension ImageProcessingClientMessage {
    static func companionHello(
        deviceID: UUID, deviceName: String, foreground: Bool,
        subjectLiftAvailable: Bool = true,
        imageDescriptionAvailable: Bool,
        automaticWork: Bool
    ) -> Self {
        #if os(macOS)
            let platform: ImageProcessingHelloPlatform = .macos
        #else
            let platform: ImageProcessingHelloPlatform = .ios
        #endif
        return .hello(
            ImageProcessingHello(
                protocolVersion: ._1,
                type: .hello,
                deviceId: deviceID.uuidString.lowercased(),
                platform: platform,
                appVersion: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString")
                    as? String ?? "unknown",
                deviceName: deviceName,
                osVersion: ProcessInfo.processInfo.operatingSystemVersionString,
                capabilities: ImageProcessingCapabilities(
                    visionSubjectLift: .init(
                        available: subjectLiftAvailable,
                        revision: subjectLiftAvailable ? 1 : nil),
                    actualImageDescription: .init(
                        available: imageDescriptionAvailable,
                        revision: imageDescriptionAvailable ? 1 : nil),
                    jpegNormalization: .init(available: true, revision: ._1),
                    foreground: foreground),
                // The device owns this switch; the server mirrors it onto the
                // `Device` row and refuses to dispatch when it is off.
                participation: .init(automaticWork: automaticWork)))
    }

    static func companionResult(_ result: ImageProcessingResult) -> Self {
        .result(.init(protocolVersion: ._1, type: .result, result: result))
    }
}

/// Execution metadata is available only after recognizing the command variant.
struct CompanionImageCommandMetadata: Sendable {
    let kind: String
    let jobKind: ImageProcessingJobKind
    let jobID: String
    let attemptID: String
    let deadline: Date
    let processor: String

    init(_ command: ImageProcessingCommand) throws {
        switch command {
        case .describeImage(let value):
            guard value.kind == .describeImage, value.promptRevision == ._1,
                value.resultSchemaRevision == ._1,
                value.analysisOutput.map({ $0.contentType == .imageJpeg }) ?? true
            else {
                throw UnsupportedNativeResponse(
                    context: "image-processing command revision or output",
                    raw: try JSONValue(encoding: command))
            }
            kind = "describe_image"
            jobKind = .describeImage
            jobID = value.jobId
            attemptID = value.attemptId
            deadline = value.deadline
            processor =
                value.analysisOutput == nil
                ? "FoundationModels.SystemLanguageModel" : "ImageIO.JPEGNormalization"
        case .subjectLift(let value):
            guard value.kind == .subjectLift, value.output.contentType == .imagePng else {
                throw UnsupportedNativeResponse(
                    context: "image-processing command output", raw: try JSONValue(encoding: command))
            }
            kind = "subject_lift"
            jobKind = .subjectLift
            jobID = value.jobId
            attemptID = value.attemptId
            deadline = value.deadline
            processor = "Vision.SubjectLift"
        case .unrecognized(let raw):
            throw UnsupportedNativeResponse(context: "image-processing command", raw: raw)
        }
    }
}
