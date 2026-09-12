import Foundation
import Testing

@testable import CubbyKit

@Suite("JSONValue")
struct JSONValueTests {
    @Test("round-trips through Codable")
    func roundTrip() throws {
        let original: JSONValue = [
            "name": "Sample Product",
            "count": 3,
            "price": 12.5,
            "active": true,
            "notes": nil,
            "tags": ["a", "b"],
        ]

        let data = try JSONEncoder().encode(original)
        let decoded = try JSONDecoder().decode(JSONValue.self, from: data)

        #expect(decoded == original)
    }

    @Test("decodes a heterogeneous JSON document")
    func decodesDocument() throws {
        let json = """
            {"id": "PRD-2345", "count": 2, "active": false, "child": {"x": 1}, "list": [1, 2, 3]}
            """
        let value = try JSONDecoder().decode(JSONValue.self, from: Data(json.utf8))

        #expect(value["id"]?.stringValue == "PRD-2345")
        #expect(value["count"]?.doubleValue == 2)
        #expect(value["active"]?.boolValue == false)
        #expect(value["child"]?["x"]?.doubleValue == 1)
        #expect(value["list"]?.arrayValue?.count == 3)
        #expect(value["missing"] == nil)
    }

    @Test("array subscript indexes and bounds-checks")
    func arraySubscript() {
        let value: JSONValue = [1, 2, 3]

        #expect(value[0]?.doubleValue == 1)
        #expect(value[2]?.doubleValue == 3)
        #expect(value[3] == nil)
        #expect(value[-1] == nil)
    }

    @Test("accessors return nil for the wrong case")
    func mismatchedAccessors() {
        let value: JSONValue = "hello"

        #expect(value.stringValue == "hello")
        #expect(value.doubleValue == nil)
        #expect(value.boolValue == nil)
        #expect(value.arrayValue == nil)
        #expect(value.objectValue == nil)
    }

    @Test("literals build the expected cases")
    func literals() {
        let null: JSONValue = nil
        let bool: JSONValue = true
        let number: JSONValue = 42
        let float: JSONValue = 3.5
        let string: JSONValue = "hi"
        let array: JSONValue = [1, "two", false]
        let object: JSONValue = ["k": "v"]

        #expect(null == .null)
        #expect(bool == .bool(true))
        #expect(number == .number(42))
        #expect(float == .number(3.5))
        #expect(string == .string("hi"))
        #expect(array == .array([.number(1), .string("two"), .bool(false)]))
        #expect(object == .object(["k": .string("v")]))
    }
}
