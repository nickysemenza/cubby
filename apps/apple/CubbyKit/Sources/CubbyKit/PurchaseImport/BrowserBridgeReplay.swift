import Foundation

public struct BrowserBridgeReplayLedger: Codable, Equatable, Sendable {
    public private(set) var completed: [UUID: BrowserBridgeCommandResult]
    public private(set) var cancelled: Set<UUID>

    public init(
        completed: [UUID: BrowserBridgeCommandResult] = [:], cancelled: Set<UUID> = []
    ) {
        self.completed = completed
        self.cancelled = cancelled
    }

    public mutating func record(_ result: BrowserBridgeCommandResult) {
        guard !cancelled.contains(result.commandID) else { return }
        completed[result.commandID] = result
    }

    public mutating func acknowledge(_ commandID: UUID) {
        completed.removeValue(forKey: commandID)
        cancelled.remove(commandID)
    }

    public mutating func cancel(_ commandID: UUID) {
        completed.removeValue(forKey: commandID)
        cancelled.insert(commandID)
    }

    public func replayResult(for commandID: UUID) -> BrowserBridgeCommandResult? {
        completed[commandID]
    }

    public var resultsForReplay: [BrowserBridgeCommandResult] {
        completed.values.sorted {
            if $0.completedAt != $1.completedAt { return $0.completedAt < $1.completedAt }
            return $0.commandID.uuidString < $1.commandID.uuidString
        }
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
        return try JSONDecoder.browserBridge.decode(
            BrowserBridgeReplayLedger.self, from: Data(contentsOf: fileURL))
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
