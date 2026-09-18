import ArgumentParser
import CubbyKit
import Foundation

/// On-device AI debug tools. Offline, no `GlobalOptions`/auth — mirrors `Parse.swift`'s FFI
/// smoke-test shape (room for a later `rank` subcommand alongside `analyze`).
struct Photo: AsyncParsableCommand {
    static let configuration = CommandConfiguration(
        abstract: "On-device photo analysis debug tools.",
        subcommands: [Analyze.self]
    )
}

extension Photo {
    /// Runs `LocalPhotoAnalyzer` and `PhotoEvidenceScorer` on local image files and dumps every
    /// signal the app's "Suggested: …" chip is built from, so a routing miss can be diagnosed
    /// without the app.
    struct Analyze: AsyncParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "analyze",
            abstract: "Run Vision classification/OCR and routing-policy scoring on local image files.",
            discussion: """
                Prints a JSON array (one object per path) even for a single file, so the output \
                shape never changes with argument count.
                """
        )

        @Argument(help: "One or more image file paths (HEIC/JPEG/PNG/WebP/GIF).")
        var paths: [String] = []
        @Flag(help: "Print structured JSON instead of a compact human table.")
        var json: Bool = false
        @Flag(
            name: .customLong("no-semantic"),
            help: "Skip the on-device Foundation Models reranker (runs by default; needs Apple Intelligence)."
        )
        var skipSemantic: Bool = false
        @Flag(
            name: .customLong("feature-print"),
            help: "Include the base64 feature-print vector (default: byte count only).")
        var includeFeaturePrint: Bool = false
        @Option(name: .customLong("max-pixels"), help: "Maximum analysis pixel dimension.")
        var maxPixels: Int?
        @Option(
            name: .customLong("max-classifications"),
            help: "Maximum Vision classifications kept per photo.")
        var maxClassifications: Int?
        @Option(
            name: .customLong("max-text"), help: "Maximum recognized-text observations kept per photo.")
        var maxText: Int?

        func run() async throws {
            guard !paths.isEmpty else { throw CLIError.message("Give at least one image path.") }
            let defaults = LocalPhotoAnalyzer.Limits()
            let analyzer = LocalPhotoAnalyzer(
                limits: LocalPhotoAnalyzer.Limits(
                    maximumConcurrentImages: defaults.maximumConcurrentImages,
                    maximumClassifications: maxClassifications ?? defaults.maximumClassifications,
                    maximumRecognizedText: maxText ?? defaults.maximumRecognizedText,
                    maximumAnalysisPixels: maxPixels ?? defaults.maximumAnalysisPixels))

            var files: [String: PhotoFile] = [:]
            var errors: [String: String] = [:]
            for path in paths {
                do {
                    files[path] = try PhotoFile.importing(URL(fileURLWithPath: path))
                } catch {
                    errors[path] = Self.describe(error)
                }
            }

            let inputs = paths.compactMap { path -> PhotoAnalysisInput? in
                guard let file = files[path] else { return nil }
                return PhotoAnalysisInput(
                    id: path, file: file,
                    provenance: PhotoAnalysisProvenance(source: .files, filename: file.filename))
            }

            var analyses: [String: PhotoLocalAnalysis] = [:]
            var analyzeMsByPath: [String: Double] = [:]
            if !inputs.isEmpty {
                let start = Date()
                do {
                    let results = try await analyzer.analyze(inputs)
                    let elapsed = Date().timeIntervalSince(start) * 1000
                    for result in results {
                        analyses[result.id] = result
                        analyzeMsByPath[result.id] = elapsed
                    }
                } catch {
                    // The batch overload cancels every in-flight task once one throws (e.g. a file
                    // that imports fine but fails Vision's thumbnail step) — fall back to isolating
                    // each file so the rest of the batch still reports instead of aborting entirely.
                    for input in inputs {
                        let fileStart = Date()
                        do {
                            analyses[input.id] = try await analyzer.analyze(input)
                            analyzeMsByPath[input.id] = Date().timeIntervalSince(fileStart) * 1000
                        } catch {
                            errors[input.id] = Self.describe(error)
                        }
                    }
                }
            }

            var semanticByPath: [String: (status: String, decisions: [JSONValue], ms: Double)] = [:]
            if !skipSemantic {
                for (path, analysis) in analyses {
                    let start = Date()
                    let result = try await Self.runSemantic(analysis)
                    let ms = Date().timeIntervalSince(start) * 1000
                    semanticByPath[path] = (result.status, result.decisions, ms)
                }
            }

            var objects: [JSONValue] = []
            var hadError = false
            for path in paths {
                if let message = errors[path] {
                    hadError = true
                    objects.append(.object(["path": .string(path), "error": .string(message)]))
                    continue
                }
                guard let file = files[path], let analysis = analyses[path] else {
                    hadError = true
                    objects.append(
                        .object([
                            "path": .string(path), "error": .string("Analysis did not complete."),
                        ]))
                    continue
                }
                objects.append(
                    Self.jsonObject(
                        path: path, file: file, analysis: analysis,
                        includeFeaturePrintData: includeFeaturePrint,
                        analyzeMs: analyzeMsByPath[path] ?? 0,
                        semantic: semanticByPath[path]))
            }

            if json {
                print(try CLI.prettyJSON(.array(objects)))
            } else {
                for path in paths {
                    Self.printHumanReport(
                        path: path, file: files[path], analysis: analyses[path], error: errors[path],
                        analyzeMs: analyzeMsByPath[path], semantic: semanticByPath[path],
                        semanticRequested: !skipSemantic)
                }
            }

            if hadError { throw ExitCode.failure }
        }

        // MARK: - Semantic reranking

        private static func runSemantic(_ analysis: PhotoLocalAnalysis) async throws -> (
            status: String, decisions: [JSONValue]
        ) {
            let candidates = PhotoImportCatalog.routingPolicies.keys
                .sorted { $0.rawValue < $1.rawValue }
                .map { key in
                    PhotoRoutingCandidate(
                        id: "type:\(key.rawValue)", routeID: "\(key.rawValue)-self",
                        description: EntityCatalog[key].plural)
                }
            let matches = PhotoEvidenceScorer.policyMatches(analysis)
            let deterministicIDs =
                matches
                .filter { $0.value.meetsMinimumScore }
                .sorted { ($0.value.classifierConfidence ?? 0) > ($1.value.classifierConfidence ?? 0) }
                .map { "type:\($0.key.rawValue)" }
            let evidence = PhotoRoutingEvidence(
                photoID: analysis.id, summary: Self.evidenceSummary(analysis),
                deterministicCandidateIDs: deterministicIDs)
            let result = try await PhotoSemanticReranker().rerank(
                evidence: [evidence], candidates: candidates)
            return (Self.statusName(result.modelStatus), result.decisions.map(Self.decisionJSON))
        }

        private static func evidenceSummary(_ analysis: PhotoLocalAnalysis) -> String {
            let classifications = analysis.classifications.prefix(3).map(\.identifier).joined(
                separator: ", ")
            let text = analysis.recognizedText.prefix(3).map(\.text).joined(separator: " / ")
            return
                "classifications: \(classifications.isEmpty ? "none" : classifications); text: \(text.isEmpty ? "none" : text)"
        }

        private static func statusName(_ status: PhotoSemanticModelStatus) -> String {
            switch status {
            case .used: "used"
            case .unavailable(let availability): "unavailable(\(availability))"
            case .failed(let failure): "failed(\(failure.rawValue))"
            }
        }

        private static func decisionJSON(_ decision: PhotoRoutingDecision) -> JSONValue {
            .object([
                "photoID": .string(decision.photoID),
                "routeID": decision.routeID.map(JSONValue.string) ?? .null,
                "candidateID": decision.candidateID.map(JSONValue.string) ?? .null,
                "explanation": .string(decision.explanation),
            ])
        }

        // MARK: - JSON assembly

        private static func jsonObject(
            path: String, file: PhotoFile, analysis: PhotoLocalAnalysis,
            includeFeaturePrintData: Bool, analyzeMs: Double,
            semantic: (status: String, decisions: [JSONValue], ms: Double)?
        ) -> JSONValue {
            let fileObject: JSONValue = .object([
                "path": .string(path),
                "filename": .string(file.filename),
                "contentType": .string(file.contentType),
                "width": .number(Double(file.width)),
                "height": .number(Double(file.height)),
                "capturedAt": analysis.capturedAt.map { .string($0.ISO8601Format()) } ?? .null,
                "aspectRatio": .number(file.aspectRatio),
            ])
            let sourceFingerprint: JSONValue =
                analysis.sourceFingerprint.map {
                    .object(["hash": .string($0.hash.hex), "aspectRatio": .number($0.aspectRatio)])
                } ?? .null
            let hashesObject: JSONValue = .object([
                "sha256": .string(analysis.sha256),
                "perceptualHash": analysis.perceptualHash.map { .string($0.hex) } ?? .null,
                "sourceFingerprint": sourceFingerprint,
            ])
            let classifications: JSONValue = .array(
                analysis.classifications.map {
                    .object(["identifier": .string($0.identifier), "confidence": .number($0.confidence)])
                })
            let recognizedText: JSONValue = .array(
                analysis.recognizedText.map {
                    .object(["text": .string($0.text), "confidence": .number($0.confidence)])
                })
            var featurePrintFields: [String: JSONValue] = [
                "revision": .string(analysis.featurePrint.revision),
                "bytes": .number(Double(analysis.featurePrint.data.count)),
            ]
            if includeFeaturePrintData {
                featurePrintFields["data"] = .string(analysis.featurePrint.data.base64EncodedString())
            }

            let matches = PhotoEvidenceScorer.policyMatches(analysis)
            let routing: JSONValue = .array(
                PhotoImportCatalog.routingPolicies
                    .sorted { $0.key.rawValue < $1.key.rawValue }
                    .map { key, policy -> JSONValue in
                        let match = matches[key]!
                        var classifierMatch: JSONValue = .null
                        if let identifier = match.classifierIdentifier,
                            let confidence = match.classifierConfidence
                        {
                            classifierMatch = .object([
                                "identifier": .string(identifier), "confidence": .number(confidence),
                            ])
                        }
                        return .object([
                            "entity": .string(key.rawValue),
                            "classifierMatch": classifierMatch,
                            "minimumScore": .number(match.minimumScore),
                            "meetsMinimumScore": .bool(match.meetsMinimumScore),
                            "candidateFields": .array(policy.candidateFields.map(JSONValue.string)),
                            "temporalFields": .array(policy.temporalFields.map(JSONValue.string)),
                            "ocrFields": .array(policy.ocrFields.map(JSONValue.string)),
                        ])
                    })
            // The entity whose classifier match both clears its policy's minimum score and scores
            // highest among those that do — the same verdict `suggestedSource` surfaces in the app.
            let suggestedSource =
                matches
                .filter { $0.value.meetsMinimumScore }
                .max { ($0.value.classifierConfidence ?? 0) < ($1.value.classifierConfidence ?? 0) }
                .map { $0.key.rawValue }

            var timingsFields: [String: JSONValue] = ["analyzeMs": .number(analyzeMs)]
            var topFields: [String: JSONValue] = [
                "file": fileObject,
                "hashes": hashesObject,
                "classifications": classifications,
                "recognizedText": recognizedText,
                "featurePrint": .object(featurePrintFields),
                "routing": routing,
                "suggestedSource": suggestedSource.map(JSONValue.string) ?? .null,
                "semanticModel": .string(
                    String(
                        describing: FoundationModelsPhotoSemanticModel().availability(for: .current))),
            ]
            if let semantic {
                timingsFields["semanticMs"] = .number(semantic.ms)
                topFields["semantic"] = .object([
                    "status": .string(semantic.status),
                    "decisions": .array(semantic.decisions),
                ])
            }
            topFields["timings"] = .object(timingsFields)
            return .object(topFields)
        }

        // MARK: - Human-readable report

        /// One section per evaluation the app runs on a photo, so a routing miss can be traced to
        /// the stage that produced it. Mirrors the JSON keys; `--json` is the stable machine form.
        private static func printHumanReport(
            path: String, file: PhotoFile?, analysis: PhotoLocalAnalysis?, error: String?,
            analyzeMs: Double?, semantic: (status: String, decisions: [JSONValue], ms: Double)?,
            semanticRequested: Bool
        ) {
            if let error {
                print("\(path): ERROR \(error)")
                return
            }
            guard let file, let analysis else {
                print("\(path): ERROR Analysis did not complete.")
                return
            }
            let captured = analysis.capturedAt?.ISO8601Format() ?? "unknown"
            let ms = analyzeMs.map { String(format: "%.0f ms", $0) } ?? "-"
            print(
                "\(file.filename)  \(file.width)x\(file.height) \(file.contentType)  captured=\(captured)  analyzed in \(ms)"
            )

            print(
                "  [1] identity — sha256 + 64-bit perceptual hash (exact/near duplicate detection at staging)"
            )
            print("      sha256=\(analysis.sha256)")
            print(
                "      pHash=\(analysis.perceptualHash?.hex ?? "unavailable")"
                    + (analysis.sourceFingerprint.map {
                        String(format: "  fingerprint aspect=%.4f", $0.aspectRatio)
                    } ?? ""))

            print(
                "  [2] Vision ClassifyImageRequest r2 — scene/object labels (\(analysis.classifications.count) kept)"
            )
            if analysis.classifications.isEmpty {
                print("      none")
            } else {
                for classification in analysis.classifications {
                    print(
                        "      \(pad(classification.identifier, 28)) \(String(format: "%.3f", classification.confidence))"
                    )
                }
            }

            print(
                "  [3] Vision RecognizeTextRequest r3 (accurate) — OCR (\(analysis.recognizedText.count) kept; ≥3 chars matched against candidate fields)"
            )
            if analysis.recognizedText.isEmpty {
                print("      none")
            } else {
                for text in analysis.recognizedText {
                    print(String(format: "      %.3f  \"%@\"", text.confidence, text.text))
                }
            }

            print(
                "  [4] Vision GenerateImageFeaturePrintRequest — embedding for visual identity matching against existing gallery images"
            )
            print(
                "      revision=\(analysis.featurePrint.revision)  bytes=\(analysis.featurePrint.data.count)")

            let matches = PhotoEvidenceScorer.policyMatches(analysis)
            print("  [5] routing policies — best classifier label per entity vs. that entity's minimum score")
            for (key, policy) in PhotoImportCatalog.routingPolicies.sorted(by: {
                $0.key.rawValue < $1.key.rawValue
            }) {
                let match = matches[key]
                let verdict = match?.meetsMinimumScore == true ? "PASS" : "    "
                let label = match?.classifierIdentifier.map { "\($0)" } ?? "no label matched"
                let confidence = match?.classifierConfidence.map { String(format: "%.3f", $0) } ?? "  -  "
                print(
                    "      \(verdict) \(EntityCatalog[key].emoji) \(pad(key.rawValue, 22)) \(confidence) ≥ \(String(format: "%.2f", policy.minimumScore))  \(pad(label, 18)) wants: \(policy.classifierLabels.joined(separator: ","))"
                )
            }
            let suggested =
                matches
                .filter { $0.value.meetsMinimumScore }
                .max { ($0.value.classifierConfidence ?? 0) < ($1.value.classifierConfidence ?? 0) }
                .map { $0.key.rawValue }
            print("      suggested source: \(suggested ?? "none (photo stays in Needs a destination)")")

            let availability = String(
                describing: FoundationModelsPhotoSemanticModel().availability(for: .current))
            print("  [6] Foundation Models reranker — availability=\(availability)")
            if let semantic {
                print(String(format: "      status=%@  (%.0f ms)", semantic.status, semantic.ms))
                for case .object(let decision) in semantic.decisions {
                    let route = decision["routeID"]?.stringValue ?? "no route"
                    let candidate = decision["candidateID"]?.stringValue ?? "no candidate"
                    let explanation = decision["explanation"]?.stringValue ?? ""
                    print("      → \(route) / \(candidate): \(explanation)")
                }
            } else if !semanticRequested {
                print("      skipped (--no-semantic)")
            }
        }

        private static func pad(_ text: String, _ width: Int) -> String {
            text.count >= width ? text : text + String(repeating: " ", count: width - text.count)
        }

        private static func describe(_ error: Error) -> String {
            if let described = error as? LocalizedError, let description = described.errorDescription {
                return description
            }
            return String(describing: error)
        }
    }
}
