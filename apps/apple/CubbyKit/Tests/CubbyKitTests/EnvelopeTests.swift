import Foundation
import Testing

@testable import CubbyKit

@Suite("Envelope")
struct EnvelopeTests {
    @Test("decodes a product get response")
    func decodesProductGet() throws {
        let envelope = try Fixtures.decode(SuccessEnvelope<JSONValue>.self, from: "product-get.json")

        #expect(envelope.ok == true)
        #expect(envelope.data["id"]?.stringValue == "PRD-2345")
        #expect(envelope.data["name"]?.stringValue == "Sample Product")
        #expect(envelope.data["coverImageUrl"] == .null)
        #expect(envelope.data["images"]?.arrayValue == [])
    }

    @Test("decodes a product list page")
    func decodesProductList() throws {
        let envelope = try Fixtures.decode(
            SuccessEnvelope<ListPage<JSONValue>>.self,
            from: "products-list.json"
        )

        #expect(envelope.data.items.count == 1)
        #expect(envelope.data.items[0]["id"]?.stringValue == "PRD-2345")
        #expect(envelope.data.meta.pageIndex == 0)
        #expect(envelope.data.meta.pageSize == 20)
        #expect(envelope.data.meta.totalCount == 1)
    }

    @Test("decodes a location list page")
    func decodesLocationList() throws {
        let envelope = try Fixtures.decode(
            SuccessEnvelope<ListPage<JSONValue>>.self,
            from: "locations-list.json"
        )

        #expect(envelope.data.items.count == 1)
        #expect(envelope.data.items[0]["id"]?.stringValue == "LOC-2345")
        #expect(envelope.data.items[0]["type"]?.stringValue == "shelf")
        #expect(envelope.data.meta.totalCount == 1)
    }

    @Test("decodes a scanAtLocation 'added' outcome")
    func decodesScanAdded() throws {
        let envelope = try Fixtures.decode(SuccessEnvelope<JSONValue>.self, from: "scan-added.json")

        #expect(envelope.data["outcome"]?.stringValue == "added")
        #expect(envelope.data["product"]?["created"]?.boolValue == true)
        #expect(envelope.data["strays"]?.arrayValue == [])
    }

    @Test("decodes a scanAtLocation 'queued' outcome with a stray")
    func decodesScanQueued() throws {
        let envelope = try Fixtures.decode(SuccessEnvelope<JSONValue>.self, from: "scan-queued.json")

        #expect(envelope.data["outcome"]?.stringValue == "queued")
        #expect(envelope.data["strays"]?.arrayValue?.count == 1)
        #expect(envelope.data["strays"]?[0]?["entryId"]?.stringValue == "INV-2345")
        #expect(envelope.data["sideEffects"]?["backgroundBatches"]?.arrayValue?.count == 1)
    }

    @Test("decodes an unauthorized error envelope with detail")
    func decodesUnauthorizedError() throws {
        let body = try Fixtures.data(named: "error-unauthorized.json")
        let error = CubbyAPIError.decode(status: 401, operationID: "resources.product.get", body: body)

        #expect(error.isUnauthorized == true)
        #expect(error.detail?.code == "UNAUTHORIZED")
        #expect(error.detail?.reason == "invalid_session")
        #expect(error.detail?.requestId == "req_sample123")
    }

    @Test("decodes a validation error envelope with detail")
    func decodesValidationError() throws {
        let body = try Fixtures.data(named: "error-validation.json")
        let error = CubbyAPIError.decode(
            status: 422,
            operationID: "resources.product.create",
            body: body
        )

        #expect(error.isUnauthorized == false)
        #expect(error.detail?.code == "VALIDATION_ERROR")
        #expect(error.detail?.message == "Sample validation message")
    }

    @Test("an HTML error body decodes to a nil detail")
    func htmlBodyHasNoDetail() throws {
        let body = try Fixtures.data(named: "error-html-502.txt")
        let error = CubbyAPIError.decode(
            status: 502,
            operationID: "resources.product.list",
            body: body
        )

        #expect(error.status == 502)
        #expect(error.detail == nil)
        #expect(error.isUnauthorized == false)
    }
}
