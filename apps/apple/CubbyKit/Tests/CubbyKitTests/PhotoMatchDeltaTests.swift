import Foundation
import Testing

@testable import CubbyKit

@Suite("PhotoMatchDelta")
struct PhotoMatchDeltaTests {
    private let query = HashQuery(perceptualHash: PerceptualHash64(value: 0), aspectRatio: 1.5)

    private func entry(_ id: String, hash: UInt64?) -> ImageHashEntry {
        ImageHashEntry(
            id: ImageCode(id), perceptualHash: hash.map(PerceptualHash64.init(value:)), width: 1500,
            height: 1000)
    }

    private func fullMatch(_ entries: [ImageHashEntry]) throws -> [DedupCandidate] {
        try HashIndex(entries: entries).candidates(for: query)
    }

    /// Every case must end where a full re-match against the new index would, and re-applying the
    /// same delta must change nothing (the persisted result may already include it).
    @Test(arguments: [
        // Added entry matches.
        (old: [("IMG-A", UInt64(0xFFFF))], new: [("IMG-A", UInt64(0xFFFF)), ("IMG-B", UInt64(1))]),
        // Removed entry's candidate is dropped.
        (old: [("IMG-A", UInt64(0)), ("IMG-B", UInt64(1))], new: [("IMG-A", UInt64(0))]),
        // Changed entry is re-evaluated: it stops matching.
        (old: [("IMG-A", UInt64(0))], new: [("IMG-A", UInt64(0xFFFF))]),
        // Changed entry is re-evaluated: it starts matching.
        (old: [("IMG-A", UInt64(0xFFFF))], new: [("IMG-A", UInt64(3))]),
        // Nothing changed.
        (old: [("IMG-A", UInt64(0))], new: [("IMG-A", UInt64(0))]),
    ])
    func convergesOnAFullMatchAndIsIdempotent(
        old: [(String, UInt64)], new: [(String, UInt64)]
    ) throws {
        let oldEntries = old.map { entry($0.0, hash: $0.1) }
        let newEntries = new.map { entry($0.0, hash: $0.1) }
        let stored = try fullMatch(oldEntries)
        let delta = try PhotoMatchDelta(
            previous: Dictionary(uniqueKeysWithValues: oldEntries.map { ($0.id, $0.matchDigest) }),
            current: newEntries)
        let updated = delta.apply(to: stored, query: query)
        #expect(updated == (try fullMatch(newEntries)))
        #expect(delta.apply(to: updated, query: query) == updated)
    }

    @Test func anEmptySnapshotTreatsEveryEntryAsChanged() throws {
        let entries = [entry("IMG-A", hash: 0), entry("IMG-B", hash: 0xFFFF)]
        let delta = try PhotoMatchDelta(previous: [:], current: entries)
        #expect(delta.affectedIDs == [ImageCode("IMG-A"), ImageCode("IMG-B")])
        #expect(delta.apply(to: [], query: query) == (try fullMatch(entries)))
    }

    @Test func digestIsProcessStableAndCoversEveryMatchedField() {
        let base = ImageHashEntry(
            id: ImageCode("IMG-A"), perceptualHash: PerceptualHash64(value: 42),
            sourceFingerprint: SourceFingerprint(hash: PerceptualHash64(value: 7), aspectRatio: 1.5),
            width: 1500, height: 1000, directOwnerShortcodes: ["PRD-1"])
        // Persisted across launches, so it must not depend on a per-process `Hasher` seed.
        #expect(base.matchDigest == 5553054060576216095)
        let variants = [
            ImageHashEntry(
                id: base.id, perceptualHash: nil, sourceFingerprint: base.sourceFingerprint, width: 1500,
                height: 1000),
            ImageHashEntry(
                id: base.id, perceptualHash: PerceptualHash64(value: 0),
                sourceFingerprint: base.sourceFingerprint, width: 1500, height: 1000),
            ImageHashEntry(
                id: base.id, perceptualHash: base.perceptualHash, sourceFingerprint: nil, width: 1500,
                height: 1000),
            ImageHashEntry(
                id: base.id, perceptualHash: base.perceptualHash,
                sourceFingerprint: SourceFingerprint(hash: PerceptualHash64(value: 7), aspectRatio: 1.25),
                width: 1500, height: 1000),
            ImageHashEntry(
                id: base.id, perceptualHash: base.perceptualHash, sourceFingerprint: base.sourceFingerprint,
                width: 1501, height: 1000),
            ImageHashEntry(
                id: base.id, perceptualHash: base.perceptualHash, sourceFingerprint: base.sourceFingerprint,
                width: 1500, height: nil),
        ]
        for variant in variants { #expect(variant.matchDigest != base.matchDigest) }
        // Owners never change a match, so they must not force a re-match either.
        let reowned = ImageHashEntry(
            id: base.id, perceptualHash: base.perceptualHash, sourceFingerprint: base.sourceFingerprint,
            width: 1500, height: 1000, directOwnerShortcodes: ["PRD-2"])
        #expect(reowned.matchDigest == base.matchDigest)
    }
}
