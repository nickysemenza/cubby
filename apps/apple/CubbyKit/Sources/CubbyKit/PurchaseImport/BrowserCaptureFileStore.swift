import Foundation

/// Disposable PNG/PDF staging has an owner before any bytes are written, including interrupted captures.
public struct BrowserCaptureFileStore: Sendable {
    private let rootDirectory: URL

    public init(rootDirectory: URL) {
        self.rootDirectory = rootDirectory.standardizedFileURL
    }

    public static func caches(namespace: String, cachesDirectory: URL? = nil) throws -> Self {
        let caches =
            try cachesDirectory
            ?? FileManager.default.url(
                for: .cachesDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        // Use the complete host/account identity; truncating a namespace can alias two accounts.
        return Self(
            rootDirectory: caches.appendingPathComponent(
                "Cubby/BrowserBridge/\(Data(namespace.utf8).sha256Hex)/captures", isDirectory: true))
    }

    public func captureDirectory(runID: String, commandID: UUID) throws -> URL {
        let run = try runDirectory(runID)
        let directory = run.appendingPathComponent(commandID.uuidString.lowercased(), isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory
    }

    public func removeCommand(runID: String, commandID: UUID) throws {
        try removeDirectory(
            try runDirectory(runID).appendingPathComponent(
                commandID.uuidString.lowercased(), isDirectory: true))
    }

    @concurrent
    public func forget(runID: String) async throws {
        try removeDirectory(try runDirectory(runID))
    }

    private func runDirectory(_ runID: String) throws -> URL {
        guard let id = UUID(uuidString: runID) else {
            throw CocoaError(.fileReadInvalidFileName)
        }
        return rootDirectory.appendingPathComponent(id.uuidString.lowercased(), isDirectory: true)
    }

    private func removeDirectory(_ directory: URL) throws {
        let attributes: [FileAttributeKey: Any]
        do {
            attributes = try FileManager.default.attributesOfItem(atPath: rootDirectory.path)
        } catch {
            if Self.isMissingFile(error) { return }
            throw error
        }
        guard attributes[.type] as? FileAttributeType == .typeDirectory else {
            throw CocoaError(.fileReadInvalidFileName, userInfo: [NSFilePathErrorKey: rootDirectory.path])
        }
        do {
            try FileManager.default.removeItem(at: directory)
        } catch {
            if !Self.isMissingFile(error) { throw error }
        }
    }

    private static func isMissingFile(_ error: any Error) -> Bool {
        let error = error as NSError
        return error.domain == NSCocoaErrorDomain
            && [NSFileNoSuchFileError, NSFileReadNoSuchFileError].contains(error.code)
    }
}
