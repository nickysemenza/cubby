import CubbyKit
import Foundation
import Photos
import Testing

@testable import Cubby

@MainActor
struct PhotoMatchInspectionTests {
    private enum ReadFailure: Error { case offline, shouldNotReadPhoto }

    @Test("Rendering the copy button never snapshots the entire library")
    func diagnosticPayloadIsLazy() {
        var reads = 0
        let button = CopyDiagnosticsButton {
            reads += 1
            return ["synthetic": true]
        }
        _ = button.body
        #expect(reads == 0)
    }

    @Test("Inspection preserves cache and grid evidence despite a failed server read")
    func readOnlyPartialInspection() async throws {
        let cache = try PhotoAnalysisStore.make(inMemory: true)
        try await cache.upsertHash(
            localIdentifier: "fixture-asset", modificationDate: .distantPast,
            perceptualHash: .init(value: 123), revision: 1)
        let before = try await cache.record(for: "fixture-asset")
        let matches = PhotoMatchStore()
        let snapshot = matches.inspectorSnapshot(for: "fixture-asset")
        let revision = matches.revision
        let file = try fixture()
        let thumbnail = try file.thumbnail()
        let model = PhotoMatchInspectionModel()
        await model.inspect(
            snapshot: snapshot, localIdentifier: "fixture-asset", assetWidth: file.width,
            assetHeight: file.height, assetModificationDate: .now, analysisStore: cache,
            readIndex: { throw ReadFailure.offline }, authorization: { .authorized },
            loadThumbnail: { _ in thumbnail }, materialize: { _ in file }
        ).value

        let report = try #require(model.report)
        #expect(report.initial.state == "unchecked")
        #expect(report.initial.registeredQuery == nil)
        #expect(report.cacheRead.perceptualHash == before?.perceptualHash)
        #expect(report.freshServerIndex.status == .failure)
        #expect(report.issues.contains { $0.stage == .freshIndex })
        #expect(report.inputs.thumbnail.actualHash == report.inputs.materialized.actualHash)
        let displayedInput = try #require(model.materializedThumbnail)
        #expect(displayedInput.width == report.inputs.materialized.width)
        #expect(displayedInput.height == report.inputs.materialized.height)
        #expect(try PerceptualHash64.compute(displayedInput) == report.inputs.materialized.actualHash)
        #expect(model.export?.urls.count == 3)
        #expect(try await cache.record(for: "fixture-asset") == before)
        #expect(matches.revision == revision)
        #expect(matches.inspectorSnapshot(for: "fixture-asset").registeredQuery == nil)
    }

    @Test("Permission denial leaves an exportable report without requesting Photos data")
    func permissionDenialIsExplicit() async throws {
        let model = PhotoMatchInspectionModel()
        await model.inspect(
            snapshot: PhotoMatchStore().inspectorSnapshot(for: "fixture-asset"),
            localIdentifier: "fixture-asset", assetWidth: 300, assetHeight: 200,
            assetModificationDate: nil, analysisStore: nil,
            readIndex: { throw ReadFailure.offline }, authorization: { .denied },
            loadThumbnail: { _ in
                Issue.record("Must not read thumbnail without permission");
                throw ReadFailure.shouldNotReadPhoto
            },
            materialize: { _ in
                Issue.record("Must not materialize without permission"); throw ReadFailure.shouldNotReadPhoto
            }
        ).value
        #expect(model.report?.issues.contains { $0.stage == .permission } == true)
        #expect(model.report?.inputs.thumbnail.actualHash == nil)
        #expect(model.export?.urls.count == 1)
    }

    @Test("Cancellation remains explicit and cannot publish a late result")
    func cancelledInspection() async throws {
        let model = PhotoMatchInspectionModel()
        let work = model.inspect(
            snapshot: PhotoMatchStore().inspectorSnapshot(for: "fixture-asset"),
            localIdentifier: "fixture-asset", assetWidth: 300, assetHeight: 200,
            assetModificationDate: nil, analysisStore: nil,
            readIndex: { throw ReadFailure.offline }, authorization: { .authorized },
            loadThumbnail: { _ in throw ReadFailure.shouldNotReadPhoto },
            materialize: { _ in throw ReadFailure.shouldNotReadPhoto })
        model.cancel()
        await work.value
        #expect(model.stage == nil)
        #expect(model.export == nil)
        #expect(model.report?.issues.contains { $0.stage == .cancelled } == true)
        #expect(model.report?.freshServerIndex.status == .notAttempted)
    }

    private func fixture() throws -> PhotoFile {
        let url = try #require(
            Bundle(for: PhotoMatchFixtureBundle.self).url(
                forResource: "cubby-parity-landscape-3200x1800", withExtension: "jpg"))
        return try PhotoFile.importing(url)
    }
}

private final class PhotoMatchFixtureBundle: NSObject {}
