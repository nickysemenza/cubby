import Testing

@testable import CubbyKit

@Suite("Offline scan reading")
struct ScanCodeTests {
    @Test(arguments: ["PRD-2345", " prd-2345 ", "https://cubby.example/PRD-2345"])
    func productLabelRawOrAsLabelURL(raw: String) {
        let label = CubbyLabel(raw)
        #expect(label?.key == .product)
        #expect(label?.code == "PRD-2345")
    }

    @Test func otherLabelsNameTheirEntity() {
        #expect(CubbyLabel("LOC-2345")?.key == .location)
        #expect(CubbyLabel("https://example.com/something") == nil)
        #expect(CubbyLabel("012345678905") == nil)
    }

    /// Identity only: a barcode's stored spelling, an ISBN's GTIN-14, a label's code. Anything
    /// else is sent to the server as typed, which is the one that decides what it means.
    @Test(arguments: [
        ("012345678905", "00012345678905"), ("0-306-40615-2", "09780306406157"),
        ("9780306406157", "09780306406157"), ("PRD-2345", "PRD-2345"), ("hello", "hello"),
    ])
    func scanKey(raw: String, key: String) {
        #expect(ScanCodes.key(forScanned: raw) == key)
    }
}
