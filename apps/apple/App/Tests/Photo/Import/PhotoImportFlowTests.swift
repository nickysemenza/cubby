import CoreGraphics
import CubbyKit
import Foundation
import Synchronization
import Testing

@testable import Cubby

@MainActor
@Suite("Photo import flow", .serialized)
struct PhotoImportFlowTests {
    @Test func cameraPreparationRetainsFailedBytesForRetry() async throws {
        let preparation = CameraPhotoPreparation()
        let bytes = Data("synthetic camera source".utf8)
        do {
            _ = try await preparation.prepare(bytes) { _ in throw CocoaError(.fileReadCorruptFile) }
            Issue.record("Preparation should fail")
        } catch {
            #expect(preparation.pendingData == bytes)
        }
        let retryData = try #require(preparation.pendingData)
        let expected = try selection(filename: "camera-retry.jpg")
        let result = try await preparation.prepare(retryData) { received in
            #expect(received == bytes)
            return expected
        }
        #expect(result.id == expected.id)
        #expect(preparation.pendingData == nil)
    }

    @Test func destinationUndoUsesTheSystemManagerWithoutRemovingOtherActions() throws {
        let photo = try selection(filename: "undo-destination.jpg")
        let manifest = makeManifest(items: [photo])
        let manager = UndoManager()
        manager.groupsByEvent = false
        manifest.undoManager = manager
        let otherTarget = NSObject()
        manager.beginUndoGrouping()
        manager.registerUndo(withTarget: otherTarget) { _ in }
        manager.endUndoGrouping()
        manager.beginUndoGrouping()
        manifest.moveSelected(
            to: try #require(manifest.destinationOptions.first),
            row: EntityRow(
                id: "PRD-2345", title: "Example", subtitle: nil, imageURL: nil,
                raw: ["id": "PRD-2345", "name": "Example"]))
        manager.endUndoGrouping()
        #expect(manifest.needsDestination.isEmpty)
        #expect(manager.undoActionName == "Photo destination")
        manager.undo()
        #expect(manifest.needsDestination == [photo.id])
        #expect(!manifest.canUndo)
        #expect(manager.canUndo)
    }

    // Regression for issue #9 (import run detail screen): the "ready to group" copy and the
    // "Start grouping" action appeared with zero uploaded photos, and with photos still mid
    // description. Both must wait for at least one settled (ready/skipped/failed) description.
    @Test func groupingReadinessWaitsForPhotosBeforeOfferingToStart() {
        #expect(
            PhotoGroupingReadiness(images: [], runStatus: .running)
                == .waitingForPhotos)
    }

    @Test func groupingReadinessWaitsForDescriptionsToSettleBeforeOfferingToStart() {
        let pending = PhotoRunImage(
            id: ImageCode("IMG-2345"), position: nil, capturedAt: nil, capturedAtOffsetMinutes: nil,
            targetState: .pending, skipReason: nil, originalUrl: "synthetic://shirt",
            cutoutUrl: nil, cutout: nil, describe: .pending, cloudDescriptionMissing: false,
            describeStartedAt: nil, describeCompletedAt: nil,
            describeAttemptMs: nil, describeWaitingMs: nil, localAnalysisReady: false, cutoutReason: nil,
            describeReason: nil, description: nil, recognizedText: nil, deviceWorkState: nil,
            deviceWorkError: nil, deviceWorkAttempts: 0)
        let working = PhotoRunImage(
            id: ImageCode("IMG-2346"), position: nil, capturedAt: nil, capturedAtOffsetMinutes: nil,
            targetState: .pending, skipReason: nil, originalUrl: "synthetic://label",
            cutoutUrl: nil, cutout: nil, describe: .leased, cloudDescriptionMissing: false,
            describeStartedAt: nil, describeCompletedAt: nil,
            describeAttemptMs: nil, describeWaitingMs: nil, localAnalysisReady: false, cutoutReason: nil,
            describeReason: nil, description: nil, recognizedText: nil, deviceWorkState: nil,
            deviceWorkError: nil, deviceWorkAttempts: 0)

        #expect(
            PhotoGroupingReadiness(
                images: [pending], runStatus: .running) == .processing)
        #expect(
            PhotoGroupingReadiness(
                images: [working], runStatus: .running) == .processing)
    }

    @Test func groupingReadinessKeepsQueuedDescriptionsProcessing() {
        let queued = PhotoRunImage(
            id: ImageCode("IMG-2345"), position: nil, capturedAt: nil, capturedAtOffsetMinutes: nil,
            targetState: .pending, skipReason: nil, originalUrl: "synthetic://shirt",
            cutoutUrl: nil, cutout: nil, describe: .pending, cloudDescriptionMissing: false,
            describeStartedAt: nil, describeCompletedAt: nil,
            describeAttemptMs: nil, describeWaitingMs: nil, localAnalysisReady: true, cutoutReason: nil,
            describeReason: nil, description: nil, recognizedText: nil, deviceWorkState: nil,
            deviceWorkError: nil, deviceWorkAttempts: 0)

        #expect(
            PhotoGroupingReadiness(
                images: [queued], runStatus: .running) == .processing)
    }

    @Test func groupingReadinessOffersStartOnceSettledAndRunning() {
        let ready = PhotoRunImage(
            id: ImageCode("IMG-2345"), position: nil, capturedAt: nil, capturedAtOffsetMinutes: nil,
            targetState: .pending, skipReason: nil, originalUrl: "synthetic://shirt",
            cutoutUrl: nil, cutout: nil, describe: .ready, cloudDescriptionMissing: false,
            describeStartedAt: nil, describeCompletedAt: nil,
            describeAttemptMs: nil, describeWaitingMs: nil, localAnalysisReady: true, cutoutReason: nil,
            describeReason: nil, description: nil, recognizedText: nil, deviceWorkState: nil,
            deviceWorkError: nil, deviceWorkAttempts: 0)
        let skipped = PhotoRunImage(
            id: ImageCode("IMG-2346"), position: nil, capturedAt: nil, capturedAtOffsetMinutes: nil,
            targetState: .pending, skipReason: nil, originalUrl: "synthetic://label",
            cutoutUrl: nil, cutout: nil, describe: .skipped, cloudDescriptionMissing: false,
            describeStartedAt: nil, describeCompletedAt: nil,
            describeAttemptMs: nil, describeWaitingMs: nil, localAnalysisReady: true, cutoutReason: nil,
            describeReason: nil, description: nil, recognizedText: nil, deviceWorkState: nil,
            deviceWorkError: nil, deviceWorkAttempts: 0)

        var excluded = skipped
        excluded.targetState = .skipped

        #expect(
            PhotoGroupingReadiness(
                images: [ready, excluded], runStatus: .running)
                == .readyToStart)
        #expect(
            PhotoGroupingReadiness(
                images: [ready], runStatus: .completed) == .working)
    }

    @Test func groupingReadinessSendsToWebWhenRunNeedsReviewAndPhotosExist() {
        let ready = PhotoRunImage(
            id: ImageCode("IMG-2345"), position: nil, capturedAt: nil, capturedAtOffsetMinutes: nil,
            targetState: .pending, skipReason: nil, originalUrl: "synthetic://shirt",
            cutoutUrl: nil, cutout: nil, describe: .ready, cloudDescriptionMissing: false,
            describeStartedAt: nil, describeCompletedAt: nil,
            describeAttemptMs: nil, describeWaitingMs: nil, localAnalysisReady: true, cutoutReason: nil,
            describeReason: nil, description: nil, recognizedText: nil, deviceWorkState: nil,
            deviceWorkError: nil, deviceWorkAttempts: 0)

        #expect(
            PhotoGroupingReadiness(
                images: [ready], runStatus: .needsReview)
                == .needsReviewOnWeb)
    }

    // Zero photos wins over `.needsReview`: there is nothing to review on the web either, so the
    // waiting message (not a dead-end web link) is what belongs on screen.
    @Test func groupingReadinessStaysWaitingForPhotosEvenWhenRunNeedsReview() {
        #expect(
            PhotoGroupingReadiness(images: [], runStatus: .needsReview)
                == .waitingForPhotos)
    }

    @Test func manifestKeepsUnassignedPhotosOutOfCommitUntilMoved() throws {
        let first = try selection(filename: "first.jpg")
        let second = try selection(filename: "second.jpg")
        let manifest = makeManifest(items: [first, second])

        #expect(manifest.needsDestination == [first.id, second.id])
        #expect(!manifest.canCommit)
        #expect(manifest.selectedIDs == Set(manifest.items.map(\.id)))
        let option = try #require(manifest.destinationOptions.first)
        manifest.moveSelected(
            to: option,
            row: EntityRow(
                id: "PRD-2345", title: "Example", subtitle: nil, imageURL: nil,
                raw: ["id": "PRD-2345", "name": "Example"]))

        #expect(manifest.needsDestination.isEmpty)
        #expect(manifest.groups.count == 1)
        #expect(manifest.groups[0].photoIDs == [first.id, second.id])
        #expect(manifest.groups[0].title == "Example")
        #expect(manifest.canCommit)
    }

    @Test func batchSelectionPersistsWhileFocusAdvancesAfterAssignment() throws {
        let first = try selection(filename: "first.jpg")
        let second = try selection(filename: "second.jpg")
        let manifest = makeManifest(items: [first, second])

        #expect(manifest.focusedItemID == first.id)
        #expect(manifest.selectedIDs == [first.id, second.id])
        manifest.selectPhotos([first.id])
        #expect(manifest.selectedIDs == [first.id])

        let option = try #require(manifest.destinationOptions.first)
        manifest.moveSelected(
            to: option,
            row: EntityRow(
                id: "PRD-2345", title: "Example", subtitle: nil, imageURL: nil,
                raw: ["id": "PRD-2345", "name": "Example"]))

        #expect(manifest.focusedItemID == second.id)
        #expect(manifest.selectedIDs == [first.id])
    }

    @Test func finishingAssignmentsPreservesBatchSelection() throws {
        let first = try selection(filename: "first.jpg")
        let second = try selection(filename: "second.jpg")
        let manifest = makeManifest(items: [first, second])
        manifest.selectedIDs = [first.id, second.id]
        let option = try #require(manifest.destinationOptions.first)

        manifest.moveSelected(
            to: option,
            row: EntityRow(
                id: "PRD-2345", title: "Example", subtitle: nil, imageURL: nil,
                raw: ["id": "PRD-2345", "name": "Example"]))

        #expect(manifest.focusedItemID == first.id)
        #expect(manifest.selectedIDs == [first.id, second.id])
        manifest.toggle(second.id)
        #expect(manifest.focusedItemID == second.id)
        #expect(manifest.selectedIDs == [first.id])
    }

    /// A1 regression: `scopedCaptureDate` (and therefore every editor/stage prefill) falls back to
    /// the whole batch when the selection is empty, exactly like `scopedHeroItems` — the original
    /// bug read `selectedItems.compactMap(\.capturedAt).min()` directly with no such fallback, so
    /// deselecting (or an auto-assign, or the analyzer) silently lost the photo's date.
    @Test func editorPrefillStillCarriesThePhotoDayWhenSelectionIsEmptied() throws {
        let captured = Date(timeIntervalSince1970: 1_757_500_000)
        let item = try selection(filename: "dated.jpg", capturedAt: captured)
        let manifest = makeManifest(items: [item])
        manifest.selectedIDs = []

        let option = try #require(
            manifest.destinationOptions.first {
                $0.route.kind == .createRelated && $0.route.source == .planting
            })
        let source = EntityRow(
            id: "PLT-0001", title: "Roma", subtitle: nil, imageURL: nil, raw: ["id": "PLT-0001"])

        #expect(manifest.scopedCaptureDate == captured)
        let body = PhotoRelatedCreateEditor.createPrefill(
            option: option, source: source, captureDate: manifest.scopedCaptureDate)
        #expect(body["observedOn"] == .string(PlainDate(captured).rawValue))
    }

    /// Safe suggestions stage for the batch confirmation, but later analysis preserves member edits.
    @Test func analyzerSuggestionsStagePhotosAndPreserveMemberChoices() async throws {
        let item = try selection(filename: "match.jpg")
        let manifest = makeManifest(items: [item])
        let option = try #require(
            manifest.destinationOptions.first { $0.route.kind == .`self` && $0.route.source == .product })
        let row = EntityRow(
            id: "PRD-9999", title: "Example", subtitle: nil, imageURL: nil,
            raw: ["id": "PRD-9999", "name": "Example"])
        let routing = PhotoRoutingCandidate(id: "candidate-1", routeID: option.id, description: row.title)
        let candidate = PhotoImportManifest.Candidate(option: option, row: row, routing: routing)
        let decision = PhotoRoutingDecision(
            photoID: item.id, routeID: option.id, candidateID: routing.id, explanation: "Matched by test")
        let client = try routeClient(gardenEntries: [])

        await manifest.applyRoutingDecisions([decision], candidates: [routing.id: candidate], client: client)

        #expect(manifest.selectedIDs == [item.id])
        #expect(manifest.groups.first?.id == "\(option.id):PRD-9999")
        #expect(manifest.needsDestination.isEmpty)
        #expect(!manifest.hasStagedChanges)
        #expect(manifest.canCommit)

        manifest.moveSelected(
            to: option,
            row: EntityRow(
                id: "PRD-9998", title: "Member choice", subtitle: nil, imageURL: nil,
                raw: ["id": "PRD-9998", "name": "Member choice"]))
        await manifest.applyRoutingDecisions([decision], candidates: [routing.id: candidate], client: client)
        #expect(manifest.groups.first?.id == "\(option.id):PRD-9998")
        #expect(manifest.hasStagedChanges)
        manifest.undoLastMove()
        #expect(manifest.groups.first?.id == "\(option.id):PRD-9999")
    }

    /// A1 (Q7b): an undated photo's capture-date-bound field never gets a value from `createPrefill`
    /// and `hasOnlyOptionalFields` must not treat it as optional just because its schema default is
    /// `initial: "today"` — the editor must open and require a real date from the person.
    @Test func undatedPhotoLeavesObservedOnAbsentAndRequired() throws {
        let item = try selection(filename: "undated.jpg")
        let manifest = makeManifest(items: [item])
        let option = try #require(
            manifest.destinationOptions.first {
                $0.route.kind == .createRelated && $0.route.source == .planting
            })
        let source = EntityRow(
            id: "PLT-0002", title: "Cherokee", subtitle: nil, imageURL: nil, raw: ["id": "PLT-0002"])

        let body = PhotoRelatedCreateEditor.createPrefill(option: option, source: source, captureDate: nil)

        #expect(body["observedOn"] == nil)
        #expect(
            !PhotoRelatedCreateEditor.hasOnlyOptionalFields(
                option: option, source: source, captureDate: nil))

        manifest.stageCreate(option: option, source: source, body: ["observedOn": "2026-09-10"])
        #expect(manifest.createDraftBody(for: item.id)?["observedOn"] == "2026-09-10")
        let meal = try #require(PhotoImportManifest.createSelfOption(for: .meal))
        manifest.stageCreate(
            option: meal, source: nil, body: ["date": "2026-09-11", "name": "Synthetic supper"])
        #expect(manifest.createDraftBody(for: item.id)?["date"] == "2026-09-11")
    }

    /// A2 (Q15c): the caption is a pure function of (time, zone, city) and drops the " in …"
    /// clause entirely when there's no city.
    @Test func captureProvenanceCaptionFormatsWithAndWithoutACity() throws {
        let capturedAt = Date(timeIntervalSince1970: 1_757_500_000)
        let zone = try #require(TimeZone(identifier: "America/Los_Angeles"))
        let formatter = DateFormatter()
        formatter.dateStyle = .none
        formatter.timeStyle = .short
        formatter.timeZone = zone
        let time = formatter.string(from: capturedAt)

        #expect(
            PhotoCaptureProvenance.caption(capturedAt: capturedAt, timeZone: zone, city: "San Francisco")
                == "Set from the photo · taken \(time) in San Francisco")
        #expect(
            PhotoCaptureProvenance.caption(capturedAt: capturedAt, timeZone: zone, city: nil)
                == "Set from the photo · taken \(time)")
        #expect(
            PhotoCaptureProvenance.caption(capturedAt: capturedAt, timeZone: zone, city: "")
                == "Set from the photo · taken \(time)")
    }

    @Test func stageCreateKeysDraftsByRouteSourceRecordAndDay() throws {
        let first = try selection(filename: "first.jpg")
        let second = try selection(filename: "second.jpg")
        let manifest = makeManifest(items: [first, second])
        let option = try #require(
            manifest.destinationOptions.first {
                $0.route.kind == .createRelated && $0.route.source == .planting
            })
        let plantingA = EntityRow(
            id: "PLT-0001", title: "A", subtitle: nil, imageURL: nil, raw: ["id": "PLT-0001"])
        let plantingB = EntityRow(
            id: "PLT-0002", title: "B", subtitle: nil, imageURL: nil, raw: ["id": "PLT-0002"])

        manifest.selectedIDs = [first.id]
        manifest.stageCreate(option: option, source: plantingA, body: [:])
        manifest.selectedIDs = [second.id]
        manifest.stageCreate(option: option, source: plantingB, body: [:])

        #expect(manifest.groups.count == 2)
        #expect(manifest.commitButtonTitle.contains("2"))
    }

    @Test func stageCreateMergesTheSameSourceRecordOnTheSameDayIntoOneDraft() throws {
        let first = try selection(filename: "first.jpg")
        let second = try selection(filename: "second.jpg")
        let manifest = makeManifest(items: [first, second])
        let option = try #require(
            manifest.destinationOptions.first {
                $0.route.kind == .createRelated && $0.route.source == .planting
            })
        let planting = EntityRow(
            id: "PLT-0001", title: "A", subtitle: nil, imageURL: nil, raw: ["id": "PLT-0001"])

        manifest.selectedIDs = [first.id]
        manifest.stageCreate(option: option, source: planting, body: [:])
        manifest.selectedIDs = [second.id]
        manifest.stageCreate(option: option, source: planting, body: [:])

        #expect(manifest.groups.count == 1)
        #expect(Set(manifest.groups[0].photoIDs) == Set([first.id, second.id]))
    }

    @Test func chooseSourceRecordAutoResolvesASingleSameDayMatch() async throws {
        let first = try selection(
            filename: "first-day.jpg", capturedAt: Date(timeIntervalSince1970: 1_789_000_000))
        let second = try selection(
            filename: "second-day.jpg", capturedAt: Date(timeIntervalSince1970: 1_789_086_400))
        let manifest = makeManifest(items: [first, second])
        let type = try #require(manifest.sourceTypeOptions.first { $0.source == .planting })
        let row = EntityRow(
            id: "PLT-1234", title: "Santa Rosa", subtitle: nil, imageURL: nil,
            raw: ["id": "PLT-1234", "locationId": "LOC-0007"])
        let client = try routeClient(gardenEntries: [(id: "GDE-0001", locationId: "LOC-0007")])
        PhotoRouteTestProtocol.nextResponse.withLock { next in
            next = PhotoRouteTestProtocol.response.withLock {
                Data(
                    String(decoding: $0, as: UTF8.self).replacingOccurrences(of: "GDE-0001", with: "GDE-0002")
                        .utf8)
            }
        }

        let resolution = await manifest.chooseSourceRecord(type, row: row, client: client)

        guard case .resolved = resolution else {
            Issue.record("A single same-day match must resolve without a route picker")
            return
        }
        let existing = try #require(
            manifest.destinationOptions.first {
                $0.route.kind == .existingRelated && $0.route.source == .planting
            })
        #expect(manifest.groups.count == 2)
        #expect(manifest.groups.first(where: { $0.id == "\(existing.id):GDE-0001" })?.photoIDs == [first.id])
        #expect(manifest.groups.first(where: { $0.id == "\(existing.id):GDE-0002" })?.photoIDs == [second.id])
        #expect(manifest.needsDestination.isEmpty)
        #expect(manifest.groups.allSatisfy { $0.decision == .existingSameDay(count: 1) })
        manifest.undoLastMove()
        #expect(Set(manifest.needsDestination) == Set([first.id, second.id]))

        let pendingManifest = makeManifest(items: [first, second])
        _ = try routeClient(gardenEntries: [(id: "GDE-0002", locationId: "LOC-0007")])
        let laterDayResponse = PhotoRouteTestProtocol.response.withLock { $0 }
        let mixedClient = try routeClient(gardenEntries: [
            (id: "GDE-0001", locationId: "LOC-0007"), (id: "GDE-0003", locationId: "LOC-0007"),
        ])
        PhotoRouteTestProtocol.nextResponse.withLock { $0 = laterDayResponse }
        let pending = await pendingManifest.chooseSourceRecord(type, row: row, client: mixedClient)
        guard case .relatedChooser = pending else {
            Issue.record("The ambiguous first day must remain available for member review")
            return
        }
        #expect(pendingManifest.needsDestination == [first.id])
        #expect(pendingManifest.selectedIDs == [first.id])
        #expect(pendingManifest.groups.first?.photoIDs == [second.id])
        #expect(pendingManifest.groups.first?.id == "\(existing.id):GDE-0002")
        pendingManifest.undoLastMove()
        #expect(Set(pendingManifest.needsDestination) == Set([first.id, second.id]))
    }

    @Test func chooseSourceRecordStagesACreateDraftWithThePrefilledBodyWhenNothingMatches() async throws {
        // Dated on purpose: an undated photo leaves the required `observedOn` empty and opens the
        // editor instead (see `undatedPhotoLeavesObservedOnAbsentAndRequired`).
        let item = try selection(filename: "new.jpg", capturedAt: Date(timeIntervalSince1970: 1_789_000_000))
        let manifest = makeManifest(items: [item])
        let type = try #require(manifest.sourceTypeOptions.first { $0.source == .planting })
        let row = EntityRow(
            id: "PLT-5678", title: "Roma", subtitle: nil, imageURL: nil,
            raw: ["id": "PLT-5678", "locationId": "LOC-0009"])
        let client = try routeClient(gardenEntries: [])

        let resolution = await manifest.chooseSourceRecord(type, row: row, client: client)

        guard case .resolved = resolution else {
            Issue.record("An unmatched source with only-optional remaining create fields must stage directly")
            return
        }
        #expect(manifest.needsDestination.isEmpty)
        let body = try #require(manifest.createDraftBody(for: item.id))
        #expect(body["locationId"] == .string("LOC-0009"))
        // Developer overlays layer 2: an unconditional primary route with no matches records
        // `.automaticPrimary`.
        #expect(manifest.groups.first?.decision == .automaticPrimary)
    }

    @Test func failedRelatedLookupKeepsPhotosUnassignedAndCanRetryAnExistingMatch() async throws {
        let item = try selection(
            filename: "retry.jpg", capturedAt: Date(timeIntervalSince1970: 1_789_000_000))
        let manifest = makeManifest(items: [item])
        let type = try #require(manifest.sourceTypeOptions.first { $0.source == .planting })
        let row = EntityRow(
            id: "PLT-5678", title: "Synthetic planting", subtitle: nil, imageURL: nil,
            raw: ["id": "PLT-5678", "locationId": "LOC-0009"])
        let failed = try routeClient(gardenEntries: [], statusCode: 503)
        let resolution = await manifest.chooseSourceRecord(type, row: row, client: failed)
        guard case .relatedChooser(let option, let page) = resolution else {
            Issue.record("A refused lookup must offer retry without staging a new record")
            return
        }
        #expect(option.route.kind == .existingRelated)
        #expect(page == nil)
        #expect(!manifest.canUndo)
        #expect(!manifest.hasStagedChanges)
        #expect(manifest.groups.isEmpty)
        #expect(manifest.needsDestination == [item.id])
        #expect(manifest.createDraftBody(for: item.id) == nil)
        let retry = try routeClient(gardenEntries: [(id: "GDE-0001", locationId: "LOC-0009")])
        let retried = await manifest.chooseSourceRecord(type, row: row, client: retry)
        guard case .resolved = retried else {
            Issue.record("Retry must resolve the existing destination")
            return
        }
        #expect(manifest.groups.first?.id == "\(option.id):GDE-0001")
        #expect(manifest.createDraftBody(for: item.id) == nil)
    }

    @Test func chooseSourceRecordOpensTheRelatedChooserForMultipleMatches() async throws {
        let item = try selection(filename: "ambiguous.jpg")
        let manifest = makeManifest(items: [item])
        let type = try #require(manifest.sourceTypeOptions.first { $0.source == .planting })
        let row = EntityRow(
            id: "PLT-4321", title: "Cherokee", subtitle: nil, imageURL: nil,
            raw: ["id": "PLT-4321", "locationId": "LOC-0001"])
        let client = try routeClient(
            gardenEntries: [
                (id: "GDE-0001", locationId: "LOC-0001"), (id: "GDE-0002", locationId: "LOC-0001"),
            ])

        let resolution = await manifest.chooseSourceRecord(type, row: row, client: client)

        guard case .relatedChooser(let option, let page) = resolution else {
            Issue.record("Two same-day matches must hand the sheet a related-chooser context")
            return
        }
        #expect(option.route.kind == .existingRelated)
        #expect(page?.items.count == 2)
        #expect(manifest.needsDestination == [item.id])
    }

    @Test func chooseSourceRecordAlwaysPromptsWhenARouteIsMarkedPrompt() async throws {
        let item = try selection(filename: "inventory.jpg")
        let manifest = makeManifest(items: [item])
        let type = try #require(manifest.sourceTypeOptions.first { $0.source == .inventory })
        let row = EntityRow(
            id: "INV-0001", title: "Flour", subtitle: nil, imageURL: nil, raw: ["id": "INV-0001"])
        let client = try routeClient(gardenEntries: [])

        let resolution = await manifest.chooseSourceRecord(type, row: row, client: client)

        guard case .routePicker = resolution else {
            Issue.record("A `.prompt` route must always ask, regardless of the manifest's other routes")
            return
        }
    }

    @Test func destinationsIncludeEveryManifestIngressKind() throws {
        let manifest = makeManifest(items: [try selection(filename: "first.jpg")])
        let routes = manifest.destinationOptions.map(\.route)

        #expect(!routes.isEmpty)
        #expect(routes.allSatisfy { $0.storage != nil })
        #expect(routes.contains(where: { $0.kind == .`self` }))
        #expect(routes.contains(where: { $0.kind == .existingRelated }))
        #expect(routes.contains(where: { $0.kind == .createRelated }))
        #expect(routes.contains(where: { $0.target == .meal }))
        #expect(routes.contains(where: { $0.target == .project }))
        #expect(routes.contains(where: { $0.target == .task }))
        #expect(routes.contains(where: { $0.target == .gardenEntry }))
        #expect(
            routes.contains {
                $0.source == .recipe && $0.target == .meal && $0.kind == .existingRelated
            })
        #expect(
            routes.contains {
                $0.source == .planting && $0.target == .gardenEntry
                    && $0.kind == .createRelated
            })
    }

    @Test func naturalSourceTypesAreUniqueAndPlantingDefaultsToCreateRoute() throws {
        let manifest = makeManifest(items: [try selection(filename: "first.jpg")])
        let types = manifest.sourceTypeOptions

        #expect(Set(types.map(\.source)).count == types.count)
        let planting = try #require(types.first(where: { $0.source == .planting }))
        #expect(
            planting.options.first(where: { $0.route.choice == .primary })?.id
                == "planting-new-garden-entry")
    }

    @Test func missingNullableSourceBindingRemainsEditable() throws {
        let route = try #require(
            PhotoImportCatalog.ingressRoutes.first { $0.id == "planting-new-garden-entry" })
        let binding = try #require(route.bindings.first { $0.field == "locationId" })
        let source = EntityRow(
            id: "PLT-1234", title: "Santa Rosa", subtitle: nil, imageURL: nil,
            raw: .object(["id": .string("PLT-1234"), "locationId": .null]))

        #expect(PhotoImportManifest.nonNullSourceFieldValue(binding: binding, source: source) == nil)
    }

    /// 8a: a route's `primaryWhen` outranks the unconditional `.primary` when the picked record's
    /// field matches. Picks the predicate route from the catalog by `primaryWhen != nil`, never by
    /// entity name, so this stays correct if the manifest's declared values ever change.
    @Test func conditionalPrimaryOutranksTheUnconditionalPrimaryWhenThePredicateMatches() async throws {
        let captured = Date(timeIntervalSince1970: 1_789_000_000)
        let bed = try selection(filename: "bed.jpg", capturedAt: captured)
        let shelf = try selection(filename: "shelf.jpg", capturedAt: captured)
        let bedManifest = makeManifest(items: [bed])
        let shelfManifest = makeManifest(items: [shelf])
        let type = try #require(bedManifest.sourceTypeOptions.first { $0.source == .location })
        let conditional = try #require(type.options.first { $0.route.primaryWhen != nil })
        let predicate = try #require(conditional.route.primaryWhen)
        let bedRow = EntityRow(
            id: "LOC-0001", title: "Bed", subtitle: nil, imageURL: nil,
            raw: [
                "id": "LOC-0001", "type": "shelf",
                "fields": [
                    "type": [
                        "result": [
                            "kind": "live",
                            "decision": [
                                "outcome": ["kind": "value", "value": .string(predicate.values[0])]
                            ],
                        ]
                    ]
                ],
            ])
        let shelfRow = EntityRow(
            id: "LOC-0002", title: "Shelf", subtitle: nil, imageURL: nil,
            raw: [
                "id": "LOC-0002", "type": .string(predicate.values[0]),
                "fields": [
                    "type": [
                        "result": [
                            "kind": "live", "decision": ["outcome": ["kind": "value", "value": "shelf"]],
                        ]
                    ]
                ],
            ])
        let client = try routeClient(gardenEntries: [])

        let bedResolution = await bedManifest.chooseSourceRecord(type, row: bedRow, client: client)
        guard case .resolved = bedResolution else {
            Issue.record("A matching predicate must resolve via the conditional route")
            return
        }
        #expect(bedManifest.groups.first?.id.hasPrefix(conditional.id) == true)
        // Developer overlays layer 2: the matched predicate is recorded, not just "automatic".
        #expect(
            bedManifest.groups.first?.decision
                == .automaticConditional(field: predicate.field, value: predicate.values[0]))

        let shelfResolution = await shelfManifest.chooseSourceRecord(type, row: shelfRow, client: client)
        guard case .resolved = shelfResolution else {
            Issue.record("A non-matching row must fall back to the unconditional primary")
            return
        }
        #expect(shelfManifest.groups.first?.source == .location)
        #expect(shelfManifest.createDraftBody(for: shelf.id) == nil)
        #expect(shelfManifest.groups.first?.decision == .automaticPrimary)
    }

    /// 8c: `createSelf`'s target-of-createRelated case is discovered purely from the catalog by
    /// `target == type && kind == .createRelated`, never by entity name; its reference fields are
    /// each candidate's source-id-bound field, singular or multiple.
    @Test func createTargetOptionsExposeTheReferenceFieldsForAPickedTargetType() throws {
        let candidates = PhotoImportManifest.createTargetOptions(for: .gardenEntry)
        let referenceFields = Set(
            candidates.compactMap { option in
                option.route.bindings.first {
                    $0.source == .sourceId || $0.source == .sourceIdList
                }?.field
            })

        #expect(!candidates.isEmpty)
        #expect(candidates.allSatisfy { $0.route.kind == .createRelated && $0.route.target == .gardenEntry })
        #expect(referenceFields == ["locationId", "plantingIds"])
        let fallback = try #require(PhotoImportManifest.createSelfOption(for: .gardenEntry))
        #expect(fallback.route.kind == .createSelf)
        #expect(fallback.route.enabled)
    }

    /// 8c: a disabled `createSelf` route (e.g. Project — "create one in Projects first") must
    /// never actually stage a draft, even if something upstream calls `stageCreate` on it — the
    /// UI disabling its row is not the only guard.
    @Test func stageCreateNeverStagesADisabledRoute() throws {
        let item = try selection(filename: "disabled.jpg")
        let manifest = makeManifest(items: [item])
        let option = try #require(PhotoImportManifest.createSelfOption(for: .project))
        #expect(!option.route.enabled)

        manifest.selectedIDs = [item.id]
        manifest.stageCreate(option: option, source: nil, body: [:])

        #expect(manifest.needsDestination == [item.id])
        #expect(manifest.groups.isEmpty)
    }

    @Test func directProductPhotoReviewNamesTheDraftAndPutsProductsWithinReach() throws {
        let item = try selection(filename: "synthetic-shirt.jpg")
        let manifest = makeManifest(items: [item])
        let option = try #require(PhotoImportManifest.createSelfOption(for: .product))

        #expect(manifest.sourceTypeOptions.first?.source == .product)
        manifest.selectedIDs = [item.id]
        manifest.stageCreate(
            option: option, source: nil,
            body: ["name": .string("Synthetic Gray Crew Shirt")])

        #expect(manifest.groups.first?.title == "Synthetic Gray Crew Shirt")
        #expect(manifest.groups.first?.evidence == "New Product")
        #expect(manifest.commitButtonTitle == "Add 1 photo + Product")
    }

    @Test func aSharedVisionSuggestionTakesSelectedPhotosStraightToTheirSourceType() {
        let selected = Set(["photo-1", "photo-2"])

        #expect(
            PhotoImportManifest.preferredSourceType(
                selectedIDs: selected,
                suggestions: ["photo-1": .planting, "photo-2": .planting]) == .planting)
        #expect(
            PhotoImportManifest.preferredSourceType(
                selectedIDs: selected,
                suggestions: ["photo-1": .planting, "photo-2": .meal]) == nil)
        #expect(
            PhotoImportManifest.preferredSourceType(
                selectedIDs: selected,
                suggestions: ["photo-1": .planting]) == nil)
    }

    @Test func mixedBatchKeepsPartialSourceSuggestionsActionable() throws {

    }

    private func selection(filename: String, capturedAt: Date? = nil) throws -> PhotoSelectionItem {
        let image = try #require(
            CGContext(
                data: nil, width: 2, height: 2, bitsPerComponent: 8,
                bytesPerRow: 8, space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)?.makeImage())
        let file = try PhotoFile(
            url: URL(fileURLWithPath: "/unused-\(filename)"), filename: filename,
            contentType: "image/jpeg", size: 1, width: 2, height: 2, capturedAt: capturedAt)
        return PhotoSelectionItem(file: file, preview: image)
    }

    /// A `CubbyClient` stubbed at the network layer (same approach as `PhotoMatchStoreTests`) so
    /// `chooseSourceRecord`'s auto-resolve exercises the real `findRelated` → `CubbyClient.list`
    /// path against a canned Garden Entry list page, rather than a re-implemented loader.
    /// Each row must satisfy the generated list schema so decode refusal remains distinct from an empty page.
    private func routeClient(gardenEntries: [(id: String, locationId: String)], statusCode: Int = 200) throws
        -> CubbyClient
    {
        let items =
            gardenEntries
            .map { entry in
                """
                {"id":"\(entry.id)","locationId":"\(entry.locationId)","plantingIds":[],"kind":"note","observedOn":"2026-09-10","notes":null,"harvestAmount":null,"images":[],"displayName":"\(entry.id)","locationName":"Test bed","plantings":[],"createdAt":"2026-09-10T00:00:00Z","updatedAt":"2026-09-10T00:00:00Z","displayImages":[],"dataQuality":{"status":"complete","score":100,"facets":[],"gaps":[],"exceptions":[],"relatedGaps":[],"relatedExceptions":[]}}
                """
            }.joined(separator: ",")
        let json =
            "{\"items\":[\(items)],\"meta\":{\"pageIndex\":1,\"pageSize\":25,\"totalCount\":\(gardenEntries.count),\"hasNextPage\":false}}"
        PhotoRouteTestProtocol.response.withLock {
            $0 = Data(
                (statusCode == 200
                    ? "{\"ok\":true,\"data\":\(json)}"
                    : "{\"code\":\"UPSTREAM_ERROR\",\"message\":\"Synthetic lookup refusal\"}").utf8)
        }
        PhotoRouteTestProtocol.nextResponse.withLock { $0 = nil }
        PhotoRouteTestProtocol.statusCode.withLock { $0 = statusCode }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [PhotoRouteTestProtocol.self]
        let store = InMemorySessionTokenStore()
        try store.save(.bearer("test-route-token"), for: "photo-routes.example.invalid")
        return CubbyClient(
            baseURL: URL(string: "https://photo-routes.example.invalid")!,
            credentials: CredentialProvider(host: "photo-routes.example.invalid", store: store),
            session: URLSession(configuration: configuration))
    }
}

/// The synchronized response belongs only to this serialized suite; it never reaches a network.
nonisolated private final class PhotoRouteTestProtocol: URLProtocol, @unchecked Sendable {
    static let response = Mutex(Data())
    static let nextResponse = Mutex<Data?>(nil)
    static let statusCode = Mutex(200)
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let response = HTTPURLResponse(
            url: request.url!, statusCode: Self.statusCode.withLock { $0 }, httpVersion: nil,
            headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        let data = Self.response.withLock { $0 }
        if let next = Self.nextResponse.withLock({ value in
            let next = value
            value = nil
            return next
        }) {
            Self.response.withLock { $0 = next }
        }
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
