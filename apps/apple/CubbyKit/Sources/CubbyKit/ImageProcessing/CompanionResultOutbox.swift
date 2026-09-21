import Foundation

/// A small durable outbox for WebSocket results. Recording completes before a send begins, so a
/// disconnect after device work cannot make the server repeat that work on the next connection.
public actor CompanionResultOutbox<Result: Codable & Sendable> {
    private let fileURL: URL
    private var loaded = false
    private var results: [String: Result] = [:]

    public init(fileURL: URL) {
        self.fileURL = fileURL
    }

    public static func applicationSupport(namespace: String) throws -> Self {
        let fileURL = try AtomicCodableReplayFile.applicationSupportURL(
            directory: "ImageProcessing", namespace: namespace, fileName: "result-outbox.json")
        return Self(fileURL: fileURL)
    }

    public func pending() throws -> [(key: String, result: Result)] {
        try loadIfNeeded()
        return results.keys.sorted().compactMap { key in
            results[key].map { (key, $0) }
        }
    }

    public func result(for key: String) throws -> Result? {
        try loadIfNeeded()
        return results[key]
    }

    public func record(_ result: Result, for key: String) throws {
        try loadIfNeeded()
        results[key] = result
        try persist()
    }

    public func acknowledge(_ key: String) throws {
        try loadIfNeeded()
        guard results.removeValue(forKey: key) != nil else { return }
        try persist()
    }

    public func removeAll() throws {
        try loadIfNeeded()
        guard !results.isEmpty else { return }
        results.removeAll()
        try persist()
    }

    private func loadIfNeeded() throws {
        guard !loaded else { return }
        let restored = try AtomicCodableReplayFile.load(
            [String: Result].self, from: fileURL, decoder: .companionImageProcessing)
        results = restored ?? [:]
        loaded = true
    }

    private func persist() throws {
        try AtomicCodableReplayFile.save(
            results, to: fileURL, encoder: .companionImageProcessing)
    }
}

extension JSONEncoder {
    static var companionImageProcessing: JSONEncoder {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.sortedKeys]
        return encoder
    }
}

extension JSONDecoder {
    static var companionImageProcessing: JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }
}
