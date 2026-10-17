import Testing

@testable import CubbyKit

/// Failure: two Sources citing the same record with different pages collapse into one group,
/// so the native detail renders only the first page.
@Suite("SourceGrouping")
struct SourceGroupingTests {
    private struct Citation {
        let record: String?
        let url: String?
        let label: String
    }

    private func groups(_ citations: [Citation]) -> [[String]] {
        groupedSources(citations, record: \.record, url: \.url).map { $0.map(\.label) }
    }

    @Test func keepsEachPageOfOneRecordInItsOwnGroup() {
        let result = groups([
            Citation(record: "email:EML-4K7M", url: "https://shop.example/a", label: "a"),
            Citation(record: "email:EML-4K7M", url: "https://shop.example/b", label: "b"),
            Citation(record: "email:EML-4K7M", url: "https://shop.example/a", label: "a2"),
        ])
        #expect(result == [["a", "a2"], ["b"]])
    }

    @Test func groupsByRecordOrPageAloneAndKeepsUnidentifiedCitationsApart() {
        let result = groups([
            Citation(record: "email:EML-4K7M", url: nil, label: "r1"),
            Citation(record: nil, url: "https://shop.example/a", label: "u1"),
            Citation(record: "email:EML-4K7M", url: nil, label: "r2"),
            Citation(record: nil, url: "https://shop.example/a", label: "u2"),
            Citation(record: nil, url: nil, label: "n1"),
            Citation(record: nil, url: nil, label: "n2"),
        ])
        #expect(result == [["r1", "r2"], ["u1", "u2"], ["n1"], ["n2"]])
    }
}
