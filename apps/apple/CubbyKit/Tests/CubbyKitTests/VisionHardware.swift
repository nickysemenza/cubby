import Testing

/// Vision's foreground-instance masks (`SubjectLift`) and image feature prints
/// (`FeaturePrintIndex`) need the host's Vision models: on the iOS Simulator the mask request
/// finds no subject and feature prints are degenerate, so those contracts only hold on a real
/// Mac (`pnpm apple test`, `swift test`). Hosted CI runs these tests on macOS;
/// local simulator runs skip them rather than fail for a platform reason.
extension Trait where Self == ConditionTrait {
    static var requiresVisionHardware: Self {
        .disabled(
            if: runningOnSimulator,
            "Vision subject lifting and feature prints are unavailable on the iOS Simulator")
    }
}

private var runningOnSimulator: Bool {
    #if targetEnvironment(simulator)
        true
    #else
        false
    #endif
}
