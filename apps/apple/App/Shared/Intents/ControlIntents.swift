import AppIntents
import Foundation

#if !CUBBY_CONTROL_EXTENSION
    import CubbyKit
#endif

/// The same intent is compiled into the app and its Control Center extension.
/// OpenIntent routes execution into the app instead of the extension's process.
struct OpenCaptureControlIntent: OpenIntent {
    static let title: LocalizedStringResource = "Open Capture"
    static let description = IntentDescription("Opens Cubby's scanner and photo import tools.")
    static let supportedModes: IntentModes = .foreground(.immediate)
    @Parameter(title: "Destination", default: .capture)
    var target: CaptureControlDestination

    func perform() async throws -> some IntentResult {
        #if !CUBBY_CONTROL_EXTENSION
            await IntentContext.open(.capture(location: nil))
        #endif
        return .result()
    }
}

nonisolated enum CaptureControlDestination: String, AppEnum {
    case capture

    static let typeDisplayRepresentation = TypeDisplayRepresentation(name: "Destination")
    static let caseDisplayRepresentations: [Self: DisplayRepresentation] = [.capture: "Capture"]
}
