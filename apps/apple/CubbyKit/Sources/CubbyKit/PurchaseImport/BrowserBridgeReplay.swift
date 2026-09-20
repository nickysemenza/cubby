import Foundation

public struct BrowserBridgeReplayLedger: Codable, Equatable, Sendable {
    public private(set) var completed: [String: BrowserBridgeCommandResult]
    public private(set) var cancelled: Set<String>
    /// Completion acknowledgements are durable too. The server may close after persisting a
    /// completion but before it observes the acknowledgement; replaying this idempotent ack is
    /// safer than notifying the person twice or starting a successor run.
    public private(set) var completedRuns: [String: BrowserBridgeRunCompletion]

    public init(
        completed: [String: BrowserBridgeCommandResult] = [:], cancelled: Set<String> = [],
        completedRuns: [String: BrowserBridgeRunCompletion] = [:]
    ) {
        self.completed = completed
        self.cancelled = cancelled
        self.completedRuns = completedRuns
    }

    private enum CodingKeys: String, CodingKey { case completed, cancelled, completedRuns }

    public init(from decoder: any Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            completed: try values.decodeIfPresent(
                [String: BrowserBridgeCommandResult].self, forKey: .completed) ?? [:],
            cancelled: try values.decodeIfPresent(Set<String>.self, forKey: .cancelled) ?? [],
            completedRuns: try values.decodeIfPresent(
                [String: BrowserBridgeRunCompletion].self, forKey: .completedRuns) ?? [:])
    }

    public mutating func record(_ result: BrowserBridgeCommandResult) {
        guard !cancelled.contains(result.commandID) else { return }
        completed[result.commandID] = result
    }

    public mutating func acknowledge(_ commandID: String) {
        completed.removeValue(forKey: commandID)
        cancelled.remove(commandID)
    }

    public mutating func cancel(_ commandID: String) {
        completed.removeValue(forKey: commandID)
        cancelled.insert(commandID)
    }

    /// Drops an incompatible cached result before recording a protocol rejection for the current
    /// command identifier. This is distinct from a server cancellation, which must fence late
    /// completion writes.
    public mutating func discardReplayResult(for commandID: String) {
        completed.removeValue(forKey: commandID)
        cancelled.remove(commandID)
    }

    public func replayResult(for commandID: String) -> BrowserBridgeCommandResult? {
        completed[commandID]
    }

    /// Returns whether this Mac has not seen the terminal run event before. The caller can use
    /// that edge to create a local notification exactly once while acknowledgements continue to
    /// replay across reconnects.
    public mutating func recordRunCompletion(_ completion: BrowserBridgeRunCompletion) -> Bool {
        let isNew = completedRuns[completion.runID] == nil
        completedRuns[completion.runID] = completion
        return isNew
    }

    public var resultsForReplay: [BrowserBridgeCommandResult] {
        completed.values.sorted {
            if $0.completedAt != $1.completedAt { return $0.completedAt < $1.completedAt }
            return $0.commandID < $1.commandID
        }
    }

    public var runCompletionsForAcknowledgement: [BrowserBridgeRunCompletion] {
        completedRuns.values.sorted { $0.runID < $1.runID }
    }
}

public protocol BrowserBridgeReplayStoring: Sendable {
    func load() async throws -> BrowserBridgeReplayLedger
    func save(_ ledger: BrowserBridgeReplayLedger) async throws
}

public actor FileBrowserBridgeReplayStore: BrowserBridgeReplayStoring {
    private let fileURL: URL

    public init(fileURL: URL) {
        self.fileURL = fileURL
    }

    public static func applicationSupport(namespace: String = "default") throws
        -> FileBrowserBridgeReplayStore
    {
        let support = try FileManager.default.url(
            for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let safeNamespace = namespace.map { character in
            character.isLetter || character.isNumber || character == "-" ? character : "_"
        }
        let directory = support.appendingPathComponent(
            "Cubby/BrowserBridge/\(String(safeNamespace.prefix(80)))", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return FileBrowserBridgeReplayStore(fileURL: directory.appendingPathComponent("replay.json"))
    }

    public func load() throws -> BrowserBridgeReplayLedger {
        guard FileManager.default.fileExists(atPath: fileURL.path(percentEncoded: false)) else {
            return BrowserBridgeReplayLedger()
        }
        do {
            return try JSONDecoder.browserBridge.decode(
                BrowserBridgeReplayLedger.self, from: Data(contentsOf: fileURL))
        } catch is DecodingError {
            // v1 results cannot safely be replayed to the v2 Flue broker. Those old runs are
            // terminalized in the server migration, so start this account's new ledger cleanly.
            try? FileManager.default.removeItem(at: fileURL)
            return BrowserBridgeReplayLedger()
        }
    }

    public func save(_ ledger: BrowserBridgeReplayLedger) throws {
        let data = try JSONEncoder.browserBridge.encode(ledger)
        try data.write(to: fileURL, options: [.atomic, .completeFileProtection])
    }
}

extension JSONEncoder {
    static var browserBridge: JSONEncoder {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.sortedKeys]
        return encoder
    }
}

extension JSONDecoder {
    static var browserBridge: JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }
}
