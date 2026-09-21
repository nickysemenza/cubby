import Foundation

public enum CompanionImageProcessingProtocol {
    public static let version = 1

    public static func attemptKey(jobID: String, attemptID: String) -> String {
        "\(jobID):\(attemptID)"
    }
}

extension ImageProcessingClientMessage {
    static func companionHello(
        deviceID: UUID, foreground: Bool,
        subjectLiftAvailable: Bool = true,
        imageDescriptionAvailable: Bool
    ) -> Self {
        #if os(macOS)
            let platform: ImageProcessingHello.PlatformPayload = .macos
        #else
            let platform: ImageProcessingHello.PlatformPayload = .ios
        #endif
        return .hello(
            ImageProcessingHello(
                protocolVersion: ._1,
                _type: .hello,
                deviceId: deviceID.uuidString.lowercased(),
                platform: platform,
                appVersion: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString")
                    as? String ?? "unknown",
                capabilities: ImageProcessingCapabilities(
                    visionSubjectLift: .init(
                        available: subjectLiftAvailable,
                        revision: subjectLiftAvailable ? 1 : nil),
                    actualImageDescription: .init(
                        available: imageDescriptionAvailable,
                        revision: imageDescriptionAvailable ? 1 : nil),
                    foreground: foreground)))
    }

    static func companionResult(_ result: ImageProcessingResult) -> Self {
        .result(.init(protocolVersion: ._1, _type: .result, result: result))
    }
}

extension ImageProcessingCommand {
    var companionJobID: String {
        switch self {
        case .describeImage(let value): value.jobId
        case .subjectLift(let value): value.jobId
        }
    }

    var companionAttemptID: String {
        switch self {
        case .describeImage(let value): value.attemptId
        case .subjectLift(let value): value.attemptId
        }
    }

    var companionDeadline: Date {
        switch self {
        case .describeImage(let value): value.deadline
        case .subjectLift(let value): value.deadline
        }
    }
}
