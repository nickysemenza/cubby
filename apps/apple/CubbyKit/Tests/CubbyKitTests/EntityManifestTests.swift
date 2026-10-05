import Foundation
import Testing

@testable import CubbyKit

/// `EntityCatalog.all` decodes the bundled `entity-manifest.json` on first use and traps when it
/// cannot, so a manifest the descriptor types in `Catalog/EntityManifest.swift` do not decode
/// fails here, in CI, instead of at app launch.
@Suite("EntityManifest")
struct EntityManifestTests {
    @Test func suggestionMetadataDecodesAlongsideOlderFields() throws {
        let field = try JSONDecoder().decode(
            FieldDescriptor.self,
            from: Data(
                #"{"key":"evidenceExpectation","label":"Receipt expectation","kind":"enum","nullable":true,"suggestion":{"basis":["name","notes"],"mode":"fill"},"inCreate":true,"requiredOnCreate":false,"inUpdate":true,"showInList":false,"showInDetail":true,"listHidden":false,"mobileInteractive":false}"#
                    .utf8))
        #expect(field.suggestion?.basis == ["name", "notes"])
        #expect(field.suggestion?.mode == "fill")
        let old = try JSONDecoder().decode(
            FieldDescriptor.self,
            from: Data(
                #"{"key":"name","label":"Name","kind":"text","nullable":false,"inCreate":true,"requiredOnCreate":true,"inUpdate":true,"showInList":true,"showInDetail":true,"listHidden":false,"mobileInteractive":false}"#
                    .utf8))
        #expect(old.suggestion == nil)
    }

    // Associated-value labels, raw strings and absent optionals are wire contracts. A
    // generated descriptor must keep Swift's synthesized Codable envelopes unchanged.
    @Test func associatedValueEnvelopesAndInitializerDefaultsStayStable() throws {
        func check<T: Codable>(_ value: T, _ json: String) throws {
            let expected = try JSONSerialization.jsonObject(with: Data(json.utf8)) as? NSDictionary
            let encoded = try JSONSerialization.jsonObject(with: JSONEncoder().encode(value)) as? NSDictionary
            #expect(encoded == expected)
            let decoded = try JSONDecoder().decode(T.self, from: Data(json.utf8))
            let roundTrip =
                try JSONSerialization.jsonObject(with: JSONEncoder().encode(decoded)) as? NSDictionary
            #expect(roundTrip == expected)
        }
        try check(FilterWire.param(name: "searchQuery"), #"{"param":{"name":"searchQuery"}}"#)
        try check(
            FilterWire.range(from: "start", to: "end", presence: nil),
            #"{"range":{"from":"start","to":"end"}}"#)
        try check(DetailSection.Kind.fields(["name"]), #"{"fields":{"_0":["name"]}}"#)
        try check(DetailSection.Kind.timeline(mode: .lifecycles), #"{"timeline":{"mode":"lifecycles"}}"#)
        try check(DetailSection.Kind.slot, #"{"slot":{}}"#)
        try check(ListView.table, #"{"table":{}}"#)
        try check(
            ListView.slot(id: "synthetic.view", label: "Shelf", searchKeys: ["query"]),
            #"{"slot":{"id":"synthetic.view","label":"Shelf","searchKeys":["query"]}}"#)
        try check(ReadOnlyMatch.string("locked"), #"{"string":{"_0":"locked"}}"#)
        try check(ReadOnlyMatch.bool(false), #"{"bool":{"_0":false}}"#)
        try check(ValueSchema(node: .boolean), #"{"nullable":false,"node":{"boolean":{}}}"#)
        try check(ValueSchema(node: .text(format: nil)), #"{"nullable":false,"node":{"text":{}}}"#)
        try check(
            ValueSchema.Field(
                key: "name", label: "Name", required: true, schema: .init(node: .number(integer: true))),
            #"{"key":"name","label":"Name","required":true,"schema":{"nullable":false,"node":{"number":{"integer":true}}}}"#
        )
        try check(
            ListTotalDescriptor(id: "total", label: "Total", keys: ["cost"], format: .currencyRange),
            #"{"id":"total","label":"Total","keys":["cost"],"format":"currencyRange"}"#)
    }

    @Test func bundledManifestDecodesOneDescriptorPerEntityKey() {
        let keys = EntityCatalog.all.map(\.key)
        #expect(keys.count == EntityKey.allCases.count)
        #expect(Set(keys) == Set(EntityKey.allCases))
    }
}
