#if os(macOS)
    import Foundation
    import Synchronization
    import UserNotifications

    public final class BrowserAttentionValidity: Sendable {
        private let current = Mutex(true)
        public var isCurrent: Bool { current.withLock { $0 } }
        public func invalidate() { current.withLock { $0 = false } }
    }

    /// Persists notification edges before asking UserNotifications to present them. The broker may
    /// replay a terminal run event until its acknowledgement arrives, so this local ledger—not the
    /// delivery callback—is the exactly-once boundary for a person's notification.
    @MainActor
    public final class MacBrowserBridgeNotifier {
        private enum Key {
            static let attentionEdges = "purchaseImport.browserBridge.attentionEdges"
            static let completedRuns = "purchaseImport.browserBridge.notifiedRuns"
            static let offlineSince = "purchaseImport.browserBridge.offlineSince"
        }

        private var attentionGenerations: [String: [String: UUID]] = [:]
        private var attentionValidity: [UUID: BrowserAttentionValidity] = [:]
        private let defaults: UserDefaults
        private let notificationCenter: UNUserNotificationCenter?

        public init(
            defaults: UserDefaults = .standard, center: UNUserNotificationCenter? = nil
        ) {
            self.defaults = defaults
            self.notificationCenter = center
        }

        public func noteOffline(accountID: String, at date: Date = .now) {
            var values = offlineValues
            if values[accountID] == nil {
                values[accountID] = date.timeIntervalSince1970
                defaults.set(values, forKey: Key.offlineSince)
            }
        }

        public func notifyDelayedOfflineIfNeeded(accountID: String, now: Date = .now) async {
            guard let timestamp = offlineValues[accountID] else { return }
            guard now.timeIntervalSince1970 - timestamp >= 24 * 60 * 60 else { return }
            guard await canPresentNotifications() else { return }
            await post(
                identifier: "purchase-import-offline-\(accountID)-\(Int(timestamp))",
                title: "Purchase imports resumed",
                body: "Cubby's browser bridge was offline for more than a day and has reconnected.")
            var values = offlineValues
            values.removeValue(forKey: accountID)
            defaults.set(values, forKey: Key.offlineSince)
        }

        public func notifyRunCompleted(_ completion: BrowserBridgeRunCompletion) async {
            var notified = notifiedRunIDs
            guard notified.insert(completion.runID).inserted else { return }
            // Persist first: a process crash after enqueueing still must not create a duplicate local
            // completion notification when the server replays its durable control message.
            defaults.set(Array(notified).sorted(), forKey: Key.completedRuns)
            guard await canPresentNotifications() else { return }
            // The server writes the copy in the unit the run worked in; only a
            // completion stored before it did lacks one.
            await post(
                identifier: "purchase-import-run-\(completion.runID)",
                title: completion.notice?.title ?? "Cubby run finished",
                body: completion.notice?.body ?? "Open Runs in Cubby for its results.")
        }

        private var notifiedRunIDs: Set<String> {
            Set(defaults.stringArray(forKey: Key.completedRuns) ?? [])
        }

        private var offlineValues: [String: TimeInterval] {
            defaults.dictionary(forKey: Key.offlineSince) as? [String: TimeInterval] ?? [:]
        }

        private var center: UNUserNotificationCenter { notificationCenter ?? .current() }

        public func isAttentionCurrent(
            accountID: String, runID: String, reason: String, generation: UUID
        ) -> Bool {
            attentionGenerations[attentionKey(accountID: accountID, runID: runID)]?[reason] == generation
        }

        public func validity(for generation: UUID) -> BrowserAttentionValidity? {
            attentionValidity[generation]
        }

        public func invalidateAttention() {
            for validity in attentionValidity.values { validity.invalidate() }
            attentionValidity.removeAll()
            attentionGenerations.removeAll()
        }

        public func resolveAttentionEdge(accountID: String, runID: String, reason: String) {
            var edges = attentionEdges
            let key = attentionKey(accountID: accountID, runID: runID)
            guard let current = edges[key], current.contains(reason) else { return }
            if let generation = attentionGenerations[key]?[reason] {
                attentionValidity.removeValue(forKey: generation)?.invalidate()
            }
            attentionGenerations[key]?[reason] = nil
            let remaining = current.filter { $0 != reason }
            if remaining.isEmpty { edges.removeValue(forKey: key) } else { edges[key] = remaining }
            defaults.set(edges, forKey: Key.attentionEdges)
        }

        public func claimAttentionEdge(accountID: String, runID: String, reason: String) -> UUID? {
            var edges = attentionEdges
            let key = attentionKey(accountID: accountID, runID: runID)
            var reasons = Set(edges[key] ?? [])
            guard reasons.insert(reason).inserted else { return nil }
            let generation = UUID()
            attentionValidity[generation] = BrowserAttentionValidity()
            attentionGenerations[key, default: [:]][reason] = generation
            edges[key] = reasons.sorted()
            defaults.set(edges, forKey: Key.attentionEdges)
            return generation
        }

        public func notifyMemberAttention(
            accountID: String, runID: String, reason: String, generation: UUID, title: String, body: String,
            isCurrent: () -> Bool
        ) async -> Bool {
            let identifier = "purchase-import-attention-\(generation.uuidString)"
            return await deliverAttention(
                accountID: accountID, runID: runID, reason: reason, generation: generation,
                isCurrent: isCurrent, canPresent: { await self.canPresentNotifications() },
                post: { await self.post(identifier: identifier, title: title, body: body) },
                remove: {
                    self.center.removePendingNotificationRequests(withIdentifiers: [identifier])
                    self.center.removeDeliveredNotifications(withIdentifiers: [identifier])
                })
        }

        func deliverAttention(
            accountID: String, runID: String, reason: String, generation: UUID,
            isCurrent: () -> Bool, canPresent: () async -> Bool, post: () async -> Void, remove: () -> Void
        ) async -> Bool {
            func current() -> Bool {
                isCurrent()
                    && isAttentionCurrent(
                        accountID: accountID, runID: runID, reason: reason, generation: generation)
            }
            guard current() else { return false }
            let permitted = await canPresent()
            guard current() else { return false }
            if permitted {
                await post()
                guard current() else {
                    remove()
                    return false
                }
            }
            return true
        }

        private var attentionEdges: [String: [String]] {
            defaults.dictionary(forKey: Key.attentionEdges) as? [String: [String]] ?? [:]
        }

        private func attentionKey(accountID: String, runID: String) -> String {
            "\(accountID.utf8.count):\(accountID)\(runID)"
        }

        private func canPresentNotifications() async -> Bool {
            let settings = await center.notificationSettings()
            return switch settings.authorizationStatus {
            case .authorized, .provisional:
                true
            case .notDetermined:
                (try? await center.requestAuthorization(options: [.alert, .sound])) == true
            case .denied, .ephemeral:
                false
            @unknown default:
                false
            }
        }

        private func post(identifier: String, title: String, body: String) async {
            let content = UNMutableNotificationContent()
            content.title = title
            content.body = body
            content.sound = .default
            try? await center.add(
                UNNotificationRequest(identifier: identifier, content: content, trigger: nil))
        }
    }

#endif
