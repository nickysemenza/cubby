import Foundation

/// Owns notification tokens; each photo workflow retains its own eligibility and cancellation policy.
@MainActor
final class PhotoSystemConditionObservation {
    // NotificationCenter permits token removal from any thread. Only initialization writes this
    // array; deinit may run outside the main actor and only unregisters the immutable tokens.
    nonisolated(unsafe) private let tokens: [NSObjectProtocol]

    init(onChange: @escaping @MainActor () -> Void) {
        tokens = [
            ProcessInfo.thermalStateDidChangeNotification,
            .NSProcessInfoPowerStateDidChange,
        ].map { name in
            NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { _ in
                Task { @MainActor in onChange() }
            }
        }
    }

    deinit {
        for token in tokens { NotificationCenter.default.removeObserver(token) }
    }
}
