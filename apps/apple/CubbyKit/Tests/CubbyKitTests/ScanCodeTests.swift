import Testing

@testable import CubbyKit

@Suite("ScanCode.classify")
struct ScanCodeTests {
    @Test func productShortcodeRawOrAsLabelURL() throws {
        #expect(try ScanCode.classify("PRD-2345").get() == .product(ProductCode("PRD-2345")))
        #expect(try ScanCode.classify(" prd-2345 ").get() == .product(ProductCode("PRD-2345")))
        #expect(
            try ScanCode.classify("https://cubby.example/PRD-2345").get() == .product(ProductCode("PRD-2345"))
        )
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

    @Test func legacyPrefixRewritesToCanonical() throws {
        #expect(try ScanCode.classify("P-4K7M").get() == .product(ProductCode("PRD-4K7M")))
    }
}

@Suite("Shortcode.parse")
struct ShortcodeParseTests {
    @Test func canonicalPrefixParsesAsIs() {
        let parsed = Shortcode.parse("PRD-4K7M")
        #expect(parsed?.key == .product)
        #expect(parsed?.code == "PRD-4K7M")
    }

    @Test func legacyProductPrefixRewritesToCanonical() {
        let parsed = Shortcode.parse("P-4K7M")
        #expect(parsed?.key == .product)
        #expect(parsed?.singular == "Product")
        #expect(parsed?.code == "PRD-4K7M")
    }

    @Test func legacyLocationPrefixRewritesToCanonical() {
        let parsed = Shortcode.parse("L-4K7M")
        #expect(parsed?.key == .location)
        #expect(parsed?.code == "LOC-4K7M")
    }

    @Test func legacyPrefixIsCaseInsensitive() {
        let parsed = Shortcode.parse("p-4k7m")
        #expect(parsed?.key == .product)
        #expect(parsed?.code == "PRD-4K7M")
    }

    @Test func unknownSingleLetterPrefixIsNil() {
        #expect(Shortcode.parse("X-4K7M") == nil)
    }

    @Test func legacyPrefixExtractedFromLabelURL() {
        let parsed = Shortcode.extract(from: "https://cubby.nickysemenza.com/L-4K7M")
        #expect(parsed?.key == .location)
        #expect(parsed?.code == "LOC-4K7M")
    }
}
