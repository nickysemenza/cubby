import Testing

@testable import CubbyKit

/// Both tests pull the debounced sequence one value at a time. Collecting in a detached task
/// and waiting for a count is timing-dependent under a parallel suite — if the collector is
/// scheduled late, two well-spaced sends collapse into one and the wait never ends.
@Suite("SearchDebouncer")
struct SearchDebouncerTests {
    @Test func rapidSendsCollapseToTheLastValue() async throws {
        let debouncer = SearchDebouncer(interval: .milliseconds(30))
        var values = debouncer.values().makeAsyncIterator()
        debouncer.send("a")
        debouncer.send("ap")
        debouncer.send("app")
        #expect(try await values.next() == "app")
    }

    @Test func aSendAfterTheWindowArrivesOnItsOwn() async throws {
        let debouncer = SearchDebouncer(interval: .milliseconds(20))
        var values = debouncer.values().makeAsyncIterator()
        debouncer.send("a")
        #expect(try await values.next() == "a")
        debouncer.send("")
        #expect(try await values.next() == "")
    }
}
