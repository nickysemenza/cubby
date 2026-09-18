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

            var reports: [String: PhotoDiagnosticsReport] = [:]
            for path in paths {
                guard let file = files[path], let analysis = analyses[path] else { continue }
                reports[path] = await PhotoDiagnostics.report(
                    analysis: analysis, file: file, includeFeaturePrintData: includeFeaturePrint,
                    runSemantic: !skipSemantic, analyzeMs: analyzeMsByPath[path] ?? 0)
            }

            var entries: [CLIAnalyzeEntry] = []
            var hadError = false
            for path in paths {
                if let message = errors[path] {
                    hadError = true
                    entries.append(.failure(path: path, error: message))
                    continue
                }
                guard let report = reports[path] else {
                    hadError = true
                    entries.append(.failure(path: path, error: "Analysis did not complete."))
                    continue
                }
                entries.append(.report(report))
            }

            if json {
                let encoder = JSONEncoder()
                encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
                encoder.dateEncodingStrategy = .iso8601
                print(String(decoding: try encoder.encode(entries), as: UTF8.self))
            } else {
                for path in paths {
                    if let message = errors[path] {
                        print("\(path): ERROR \(message)")
                    } else if let report = reports[path] {
                        Self.printHumanReport(
                            path: path, report: report, semanticRequested: !skipSemantic)
                    } else {
                        print("\(path): ERROR Analysis did not complete.")
                    }
                }
            }

            if hadError { throw ExitCode.failure }
        }

        // MARK: - JSON assembly

        /// One array entry per requested path: a full report for a photo that analyzed, or a bare
        /// `{path, error}` object for one that didn't — so the array shape never changes with
        /// argument count and a partial-batch failure never hides the successes around it.
        private enum CLIAnalyzeEntry: Encodable {
            case report(PhotoDiagnosticsReport)
            case failure(path: String, error: String)

            private enum FailureKeys: String, CodingKey { case path, error }

            func encode(to encoder: Encoder) throws {
                switch self {
                case .report(let report):
                    try report.encode(to: encoder)
                case .failure(let path, let error):
                    var container = encoder.container(keyedBy: FailureKeys.self)
                    try container.encode(path, forKey: .path)
                    try container.encode(error, forKey: .error)
                }
            }
        }

        // MARK: - Human-readable report

        /// One section per evaluation the app runs on a photo, so a routing miss can be traced to
        /// the stage that produced it. Mirrors the JSON keys; `--json` is the stable machine form.
        private static func printHumanReport(
            path: String, report: PhotoDiagnosticsReport, semanticRequested: Bool
        ) {
            let file = report.file
            let captured = file.capturedAt?.ISO8601Format() ?? "unknown"
            let ms = String(format: "%.0f ms", report.timings.analyzeMs)
            print(
                "\(file.filename)  \(file.width)x\(file.height) \(file.contentType)  captured=\(captured)  analyzed in \(ms)"
            )

            print(
                "  [1] identity — sha256 + 64-bit perceptual hash (exact/near duplicate detection at staging)"
            )
            print("      sha256=\(report.identity.sha256)")
            print(
                "      pHash=\(report.identity.perceptualHash ?? "unavailable")"
                    + (report.identity.sourceFingerprint.map {
                        String(format: "  fingerprint aspect=%.4f", $0.aspectRatio)
                    } ?? ""))

            print(
                "  [2] Vision ClassifyImageRequest r2 — scene/object labels (\(report.classifications.count) kept)"
            )
            if report.classifications.isEmpty {
                print("      none")
            } else {
                for classification in report.classifications {
                    print(
                        "      \(pad(classification.identifier, 28)) \(String(format: "%.3f", classification.confidence))"
                    )
                }
            }

            print(
                "  [3] Vision RecognizeTextRequest r3 (accurate) — OCR (\(report.recognizedText.count) kept; ≥3 chars matched against candidate fields)"
            )
            if report.recognizedText.isEmpty {
                print("      none")
            } else {
                for text in report.recognizedText {
                    print(String(format: "      %.3f  \"%@\"", text.confidence, text.text))
                }
            }

            print(
                "  [4] Vision GenerateImageFeaturePrintRequest — embedding for visual identity matching against existing gallery images"
            )
            print(
                "      revision=\(report.featurePrint.revision)  bytes=\(report.featurePrint.bytes)")

            print("  [5] routing policies — best classifier label per entity vs. that entity's minimum score")
            for verdict in report.routing {
                let flag = verdict.meetsMinimumScore ? "PASS" : "    "
                let label = verdict.classifierIdentifier.map { "\($0)" } ?? "no label matched"
                let confidence = verdict.classifierConfidence.map { String(format: "%.3f", $0) } ?? "  -  "
                print(
                    "      \(flag) \(verdict.emoji) \(pad(verdict.entity.rawValue, 22)) \(confidence) ≥ \(String(format: "%.2f", verdict.minimumScore))  \(pad(label, 18)) wants: \(verdict.wantedLabels.joined(separator: ","))"
                )
            }
            print(
                "      suggested source: \(report.suggestedSource?.rawValue ?? "none (photo stays in Needs a destination)")"
            )

            print("  [6] Foundation Models reranker — availability=\(report.semanticModel)")
            if let semantic = report.semantic {
                let ms = report.timings.semanticMs ?? 0
                print(String(format: "      status=%@  (%.0f ms)", semantic.status, ms))
                for decision in semantic.decisions {
                    print(
                        "      → \(decision.routeID ?? "no route") / \(decision.candidateID ?? "no candidate"): \(decision.explanation)"
                    )
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
