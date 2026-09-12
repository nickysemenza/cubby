import Testing

@testable import CubbyKit

@Suite("InMemorySessionTokenStore")
struct TokenStoreTests {
    @Test("round-trips a saved credential")
    func roundTrip() throws {
        let store = InMemorySessionTokenStore()

        #expect(try store.load(for: "localhost:3000") == nil)

        try store.save(.bearer("token-abc"), for: "localhost:3000")

        #expect(try store.load(for: "localhost:3000") == .bearer("token-abc"))
    }

    @Test("overwrites an existing credential for the same host")
    func overwrite() throws {
        let store = InMemorySessionTokenStore()

        try store.save(.bearer("first-token"), for: "localhost:3000")
        try store.save(.bearer("second-token"), for: "localhost:3000")

        #expect(try store.load(for: "localhost:3000") == .bearer("second-token"))
    }

    @Test("clear removes the stored credential")
    func clear() throws {
        let store = InMemorySessionTokenStore()

        try store.save(.bearer("token-abc"), for: "localhost:3000")
        try store.clear(for: "localhost:3000")

        #expect(try store.load(for: "localhost:3000") == nil)
    }

    @Test("clearing an absent host is a no-op")
    func clearAbsentHost() throws {
        let store = InMemorySessionTokenStore()

        try store.clear(for: "never-saved.example")

        #expect(try store.load(for: "never-saved.example") == nil)
    }

    @Test("credentials are isolated per host")
    func perHostIsolation() throws {
        let store = InMemorySessionTokenStore()

        try store.save(.bearer("dev-token"), for: "localhost:3000")
        try store.save(.apiKey("prod-key"), for: "cubby.example")

        #expect(try store.load(for: "localhost:3000") == .bearer("dev-token"))
        #expect(try store.load(for: "cubby.example") == .apiKey("prod-key"))

        try store.clear(for: "localhost:3000")

        #expect(try store.load(for: "localhost:3000") == nil)
        #expect(try store.load(for: "cubby.example") == .apiKey("prod-key"))
    }
}
