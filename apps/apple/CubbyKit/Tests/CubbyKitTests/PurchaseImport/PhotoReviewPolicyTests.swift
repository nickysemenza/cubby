import Foundation
import Testing

@testable import CubbyKit

@Suite("Photo review projection")
struct PhotoReviewPolicyTests {
    // Native must accept a ready server projection even without the retired confirmation gate
    // or when selected Product changes are present. Conversely, server blockers exclude batches.
    @Test func serverProjectionOwnsReadinessAndDecodesCrossCheck() throws {
        let data = Data(
            """
            {"groupKey":"shirt","steps":[
              {"key":"identity","label":"Right one?","status":"needs_input","summary":null,"action":"change","blockedReason":null}],
             "crossCheck":[{"field":"size","mark":"disagree-or-missing","source":"model","tokens":[{"text":"10","mark":"unknown"}]}],
             "blockedReason":null,"state":"proposed","images":[],"skip":[],
             "product":{"kind":"create","create":{"name":"Synthetic shirt"}},
             "missingImageCount":0,"updatedAt":"2026-10-01T12:00:00Z"}
            """.utf8)
        var ready = try JSONDecoder().decode(PhotoGroupProposal.self, from: data)
        #expect(ready.steps.first?.status == .needsInput)
        #expect(ready.crossCheck?.first?.tokens.first?.text == "10")
        #expect(ready.crossCheck?.first?.mark.rawValue == "disagree-or-missing")
        #expect(ready.blockedReason == nil)
        ready.review = .init(
            observedName: "Synthetic shirt", stockIntent: .evidence,
            productChanges: .init(notes: "Synthetic label notes"))
        var blocked = ready
        blocked.groupKey = "blocked"
        blocked.blockedReason = "Read the synthetic label"
        var settled = ready
        settled.groupKey = "settled"
        settled.state = .committed
        #expect(
            PhotoReviewPolicy.approvableSelection(
                selected: ["shirt", "blocked", "settled"], groups: [ready, blocked, settled]) == ["shirt"])
    }

    // Saving inventory must not erase agent concerns, selected Product edits, photo purposes,
    // skipped photos, or explicit household ownership (a null owner on the wire).
    @Test func ownershipEditsPreserveProposalAndNullableOwner() throws {
        let group = try JSONDecoder.cubby().decode(
            PhotoGroupProposal.self,
            from: Data(
                """
                {"groupKey":"shirt","steps":[],"blockedReason":"Check label","state":"proposed",
                 "images":[{"id":"IMG-4K7M","purpose":"label"}],
                 "skip":[{"id":"IMG-7K4M","reason":"Blurred"}],
                 "product":{"kind":"existing","existing":{"id":"PRD-4K7M","name":"Synthetic shirt","coverUrl":null}},
                 "review":{"observedName":"Synthetic shirt","unresolvedReason":"Check label","stockIntent":"counted",
                   "productChanges":{"notes":"Synthetic label"},
                   "resolvedConcerns":[{"reason":"Synthetic old concern","reply":null,"by":"synthetic-member","at":"2026-10-01T10:00:00Z"}]},
                 "inventory":{"locationId":"LOC-4K7M","locationName":"Example shelf","quantity":2,
                   "mode":"add","ownershipMode":"explicit","ownerPartyId":null},
                 "evidence":"Synthetic evidence","missingImageCount":0,"updatedAt":"2026-10-01T12:00:00Z"}
                """.utf8))
        let edit = try PhotoReviewEdits.ownership(group: group, locationID: "LOC-4K7M", quantity: 3)
        #expect(edit["product"]?["existingId"]?.stringValue == "PRD-4K7M")
        #expect(edit["review"]?["unresolvedReason"]?.stringValue == "Check label")
        #expect(edit["review"]?["productChanges"]?["notes"]?.stringValue == "Synthetic label")
        #expect(edit["review"]?["resolvedConcerns"]?.arrayValue?.first?["reply"] == .null)
        #expect(edit["review"]?["stockIntent"]?.stringValue == "receive")
        #expect(edit["inventory"]?["ownerPartyId"] == .null)
        #expect(edit["inventory"]?["mode"]?.stringValue == "add")
        #expect(edit["images"]?.arrayValue?.first?["purpose"]?.stringValue == "label")
        #expect(edit["skip"]?.arrayValue?.count == 1)
        #expect(edit["evidence"]?.stringValue == "Synthetic evidence")
        let moved = try PhotoReviewEdits.ownership(group: group, locationID: "LOC-7K4M", quantity: 1)
        #expect(moved["inventory"]?["mode"]?.stringValue == "create")
        #expect(moved["inventory"]?["existingEntryId"] == nil)
        let reference = try PhotoReviewEdits.ownership(group: group, locationID: nil, quantity: 3)
        let counted = try PhotoReviewEdits.ownership(
            group: group, locationID: nil, quantity: 1, stockIntent: "counted")
        #expect(counted["review"]?["stockIntent"]?.stringValue == "counted")
        #expect(counted["inventory"] == nil)
        var resolved = group
        resolved.review?.unresolvedReason = nil
        let resolvedEdit = try PhotoReviewEdits.ownership(group: resolved, locationID: nil, quantity: 1)
        #expect(resolvedEdit["review"]?["unresolvedReason"] == .null)
        #expect(reference["inventory"] == nil)
        #expect(reference["review"]?["stockIntent"]?.stringValue == "evidence")
        #expect(reference["review"]?["unresolvedReason"]?.stringValue == "Check label")
    }

    @Test func modelAgreementCannotDrawDeterministicCheckmark() throws {
        let data = Data(
            """
            {"field":"size","mark":"agree","source":"model","tokens":[]}
            """.utf8)
        var check = try JSONDecoder().decode(PhotoFieldCrossCheck.self, from: data)
        #expect(PhotoReviewPolicy.crossCheckMark(check) == "?")
        check.source = .deterministic
        #expect(PhotoReviewPolicy.crossCheckMark(check) == "✓")
        check.mark = .disagreeOrMissing
        #expect(PhotoReviewPolicy.crossCheckMark(check) == "!")
    }

    // Capture timestamps and Ordered/Paid must survive the native evidence boundary.
    @Test func evidenceRetainsHeroDateAndPhotoCapture() throws {
        let data = Data(
            """
            {"id":"PRD-4K7M","name":"Synthetic shirt","coverUrl":null,"manufacturer":null,"model":null,"identifiers":[],
             "purchaseLines":[{"expenseId":"EXP-4K7M","purchaseId":null,"purchaseLabel":null,"name":"Synthetic shirt",
              "date":"2026-10-01","dateLabel":"Paid","vendor":"Example shop","cost":12,"productQuantity":2,"movement":"acquired"}],
             "ownPhotos":[{"id":"IMG-4K7M","url":"https://example.invalid/shirt.png","capturedAt":"2026-10-02T12:00:00Z"}]}
            """.utf8)
        let evidence = try JSONDecoder().decode(PhotoProductEvidence.self, from: data)
        #expect(evidence.purchaseLines?.first?.dateLabel?.rawValue == "Paid")
        #expect(evidence.purchaseLines?.first?.vendor == "Example shop")
        #expect(evidence.ownPhotos?.first?.capturedAt == "2026-10-02T12:00:00Z")
    }
}
