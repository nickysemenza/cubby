import Foundation
import Testing

@testable import CubbyKit

@Suite("QueryEncoding (ts-rest jsonQuery)")
struct QueryEncodingTests {
    @Test func plainStringsTravelLiterally() {
        #expect(QueryEncoding.encode(.string("flour")) == "flour")
        #expect(QueryEncoding.encode(.string("PRD-2345")) == "PRD-2345")
    }

    @Test func nonStringsTravelAsJSON() {
        #expect(QueryEncoding.encode(.number(2)) == "2")
        #expect(QueryEncoding.encode(.bool(true)) == "true")
        #expect(QueryEncoding.encode(.null) == "null")
        #expect(QueryEncoding.encode(["a", 1]) == "[\"a\",1]")
        #expect(QueryEncoding.encode(["b": 1, "a": "x"]) == "{\"a\":\"x\",\"b\":1}")
    }

    @Test func stringsThatLookLikeJSONAreQuoted() {
        #expect(QueryEncoding.encode(.string("12")) == "\"12\"")
        #expect(QueryEncoding.encode(.string("true")) == "\"true\"")
        #expect(QueryEncoding.encode(.string("[1]")) == "\"[1]\"")
    }

    @Test func itemsAreSortedByName() {
        let items = QueryEncoding.queryItems(["pageSize": 50, "page": 1, "sort": "-name"])
        #expect(items.map(\.name) == ["page", "pageSize", "sort"])
        #expect(items.map(\.value) == ["1", "50", "-name"])
    }
}
