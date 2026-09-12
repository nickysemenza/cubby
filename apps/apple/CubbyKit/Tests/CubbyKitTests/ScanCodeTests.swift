import Testing

@testable import CubbyKit

@Suite("ScanCode.classify")
struct ScanCodeTests {
    @Test func productShortcodeRawOrAsLabelURL() throws {
        #expect(try ScanCode.classify("PRD-2345").get() == .product(ProductCode("PRD-2345")))
        #expect(try ScanCode.classify(" prd-2345 ").get() == .product(ProductCode("PRD-2345")))
        #expect(try ScanCode.classify("https://cubby.example/PRD-2345").get() == .product(ProductCode("PRD-2345")))
    }

    @Test func otherLabelsAreWrongKind() {
        #expect(ScanCode.classify("LOC-2345") == .failure(.wrongKind(entity: "location")))
    }

    @Test func webLinksAreRejected() {
        #expect(ScanCode.classify("https://example.com/something") == .failure(.webLink))
    }

    @Test func isbnBeatsBarcodeAndNormalizesToGTIN14() throws {
        // 978-0-306-40615-7 is the canonical ISBN-13 example; its ISBN-10 is 0-306-40615-2.
        #expect(try ScanCode.classify("9780306406157").get() == .isbn("09780306406157"))
        #expect(try ScanCode.classify("0-306-40615-2").get() == .isbn("09780306406157"))
        #expect(try ScanCode.classify("09780306406157").get() == .isbn("09780306406157"))
    }

    @Test func barcodesByLength() throws {
        #expect(try ScanCode.classify("012345678905").get() == .barcode("012345678905"))
        #expect(try ScanCode.classify("12345678").get() == .barcode("12345678"))
        #expect(try ScanCode.classify("00012345678905").get() == .barcode("00012345678905"))
        // A 13-digit code with a bad ISBN check digit is still a plain EAN-13.
        #expect(try ScanCode.classify("9780306406158").get() == .barcode("9780306406158"))
    }

    @Test func junkIsUnrecognized() {
        #expect(ScanCode.classify("") == .failure(.empty))
        #expect(ScanCode.classify("hello") == .failure(.unrecognized))
        #expect(ScanCode.classify("1234567") == .failure(.unrecognized))
    }
}
