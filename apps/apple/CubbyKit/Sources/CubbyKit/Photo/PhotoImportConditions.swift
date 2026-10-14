import Foundation
import Network
import Synchronization

/// A notification-driven gate: elapsed time never overrides Wi-Fi, power, or thermal policy.
/// The monitor and observer callbacks touch only the mutex-protected state.
public final class PhotoImportConditions: @unchecked Sendable {
    public static let shared = PhotoImportConditions()
    private struct State {
        var wifi = false
        var subscribers: [UUID: AsyncStream<Void>.Continuation] = [:]
    }
    private let state = Mutex(State())
    private let monitor = NWPathMonitor()
    private var observers: [NSObjectProtocol] = []

    private init() {
        monitor.pathUpdateHandler = { [weak self] path in
            guard let self else { return }
            self.state.withLock {
                $0.wifi =
                    path.status == .satisfied
                    && (path.usesInterfaceType(.wifi) || path.usesInterfaceType(.wiredEthernet))
                    && !path.isExpensive && !path.isConstrained
            }
            self.changed()
        }
        monitor.start(queue: DispatchQueue(label: "cubby.photo-import.conditions"))
        for name in [
            Notification.Name.NSProcessInfoPowerStateDidChange, ProcessInfo.thermalStateDidChangeNotification,
        ] {
            observers.append(
                NotificationCenter.default.addObserver(forName: name, object: nil, queue: nil) {
                    [weak self] _ in self?.changed()
                })
        }
    }

    public var waitingReason: String? {
        if !state.withLock({ $0.wifi }) { return "Waiting for unmetered Wi-Fi or Ethernet" }
        if ProcessInfo.processInfo.isLowPowerModeEnabled { return "Waiting for Low Power Mode to turn off" }
        if ProcessInfo.processInfo.thermalState.rawValue >= ProcessInfo.ThermalState.serious.rawValue {
            return "Waiting for this device to cool down"
        }
        return nil
    }

    private func changed() {
        for subscriber in state.withLock({ Array($0.subscribers.values) }) { subscriber.yield(()) }
    }

    public typealias Wait = @Sendable (@escaping @Sendable (String?) async -> Void) async throws -> Void

    public func wait(report: (@Sendable (String?) async -> Void)? = nil) async throws {
        let id = UUID()
        let (events, continuation) = AsyncStream<Void>.makeStream(bufferingPolicy: .bufferingNewest(1))
        state.withLock { $0.subscribers[id] = continuation }
        defer {
            _ = state.withLock { $0.subscribers.removeValue(forKey: id) }
            continuation.finish()
        }
        continuation.yield(())
        for await _ in events {
            try Task.checkCancellation()
            let reason = waitingReason
            await report?(reason)
            if reason == nil { return }
        }
        try Task.checkCancellation()
    }
}
