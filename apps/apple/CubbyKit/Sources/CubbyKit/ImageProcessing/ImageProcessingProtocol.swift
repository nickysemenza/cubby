import Foundation
import Synchronization

public enum CompanionImageProcessingProtocol {
    public static let version = 1
    /// The doorbell topic that rings when image work may be claimable.
    static let doorbellPath = "/api/doorbell"
    static let doorbellTopic = URLQueryItem(name: "topic", value: "imageProcessing.work")
    /// A resident worker's claim (`imageProcessing.pull` `leaseSeconds`). Short so a vanished
    /// device's work is reclaimed quickly; a live command keeps it with `heartbeatInterval` renewals.
    static let residentLeaseSeconds = 60
    /// How long a new doorbell subscription may take to greet before the attempt fails.
    static let openDeadline = Duration.seconds(15)
    /// Each in-flight command renews its lease this often through `imageProcessing.renew`, well
    /// inside `residentLeaseSeconds` so one missed renewal does not lose the lease.
    static let heartbeatInterval = Duration.seconds(15)

    public static func attemptKey(jobID: String, attemptID: String) -> String {
        "\(jobID):\(attemptID)"
    }
}

extension ImageProcessingHello {
    /// This device's capability report, sent with every `imageProcessing.pull`.
    static func companion(
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
        return ImageProcessingHello(
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
            // `Device` row and refuses to assign work when it is off.
            participation: .init(automaticWork: automaticWork))
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

/// The job and attempt a command claims, read without recognizing its variant, so a command this
/// build cannot execute is still handed back with `imageProcessing.release`.
struct CompanionImageCommandClaim: Sendable, Equatable {
    let jobID: String
    let attemptID: String

    init(jobID: String, attemptID: String) {
        self.jobID = jobID
        self.attemptID = attemptID
    }

    init?(_ command: ImageProcessingCommand) {
        if let metadata = try? CompanionImageCommandMetadata(command) {
            self.init(jobID: metadata.jobID, attemptID: metadata.attemptID)
            return
        }
        guard let raw = try? JSONValue(encoding: command),
            let jobID = raw["jobId"]?.stringValue, let attemptID = raw["attemptId"]?.stringValue
        else { return nil }
        self.init(jobID: jobID, attemptID: attemptID)
    }
}

/// `imageProcessing.renew`'s answer: the extended lease, or why the server will not extend it.
enum CompanionLeaseRenewal: Sendable, Equatable {
    case renewed(leaseExpiresAt: Date)
    /// `lease_lost` or `job_obsolete`, verbatim: the device must stop this command.
    case refused(reason: String)
}

/// One in-flight command's lease deadline. It starts at the command's `deadline` and moves with
/// every accepted `imageProcessing.renew`, so a heartbeated command is not cut off at its first
/// lease. The worker binds it as a task-local around `execute`, which reaches the executor's
/// deadline checks without widening every `execute` closure.
final class CompanionCommandLease: Sendable {
    @TaskLocal static var current: CompanionCommandLease?

    private let storedDeadline: Mutex<Date>

    init(deadline: Date) {
        storedDeadline = Mutex(deadline)
    }

    var deadline: Date { storedDeadline.withLock { $0 } }

    /// Moves the deadline later; a stale or earlier renewal never shortens it.
    func extend(to deadline: Date) {
        storedDeadline.withLock { $0 = max($0, deadline) }
    }
}
