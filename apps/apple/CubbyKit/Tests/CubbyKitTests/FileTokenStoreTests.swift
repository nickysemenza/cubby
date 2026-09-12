import Foundation
import Testing

@testable import CubbyKit

@Suite("FileSessionTokenStore")
struct FileTokenStoreTests {
    private func temporaryStore() -> FileSessionTokenStore {
        // A space in the path: `URL.path()` percent-encodes it, which once broke the permission
        // step on "~/Library/Application Support".
        let dir = FileManager.default.temporaryDirectory.appending(path: "cubby store \(UUID().uuidString)")
        return FileSessionTokenStore(fileURL: dir.appending(path: "credentials.json"))
    }

    @Test func roundTripsPerHostWithOwnerOnlyPermissions() throws {
        let store = temporaryStore()
        #expect(try store.load(for: "a.example") == nil)
        try store.save(.bearer("tok.a"), for: "a.example")
        try store.save(.apiKey("cubby_b"), for: "b.example")
        #expect(try store.load(for: "a.example") == .bearer("tok.a"))
        #expect(try store.load(for: "b.example") == .apiKey("cubby_b"))

        let attributes = try FileManager.default.attributesOfItem(atPath: store.fileURL.path(percentEncoded: false))
        #expect((attributes[.posixPermissions] as? Int) == 0o600)

        try store.clear(for: "a.example")
        #expect(try store.load(for: "a.example") == nil)
        #expect(try store.load(for: "b.example") == .apiKey("cubby_b"))
        try? FileManager.default.removeItem(at: store.fileURL.deletingLastPathComponent())
    }
}
