import Foundation

public struct NearbyReceiptSearchContext: Hashable, Sendable {
    public let huntID: String
    public let transactionDate: Date
    public let merchant: String?
    public let amountInCents: Int?

    public init(
        huntID: String, transactionDate: Date, merchant: String? = nil, amountInCents: Int? = nil
    ) {
        self.huntID = huntID
        self.transactionDate = transactionDate
        self.merchant = merchant
        self.amountInCents = amountInCents
    }
}

public struct NearbyReceiptCandidateSignals: Hashable, Sendable {
    public let id: String
    public let capturedAt: Date
    public let classifications: [PhotoClassification]
    public let recognizedText: [PhotoRecognizedText]

    public init(
        id: String, capturedAt: Date, classifications: [PhotoClassification],
        recognizedText: [PhotoRecognizedText]
    ) {
        self.id = id
        self.capturedAt = capturedAt
        self.classifications = classifications
        self.recognizedText = recognizedText
    }
}

public struct NearbyReceiptCandidateScore: Hashable, Sendable {
    public let id: String
    public let total: Double
    public let receiptLikelihood: Double
    public let merchantMatch: Double
    public let amountMatch: Double
    public let dateProximity: Double

    public init(
        id: String, total: Double, receiptLikelihood: Double, merchantMatch: Double,
        amountMatch: Double, dateProximity: Double
    ) {
        self.id = id
        self.total = total
        self.receiptLikelihood = receiptLikelihood
        self.merchantMatch = merchantMatch
        self.amountMatch = amountMatch
        self.dateProximity = dateProximity
    }
}

public enum NearbyReceiptRanker {
    public static let searchWindowDays = 3

    public static func rank(
        _ candidates: [NearbyReceiptCandidateSignals], for context: NearbyReceiptSearchContext,
        calendar: Calendar = .current
    ) -> [NearbyReceiptCandidateScore] {
        candidates.compactMap { candidate in
            guard
                let days = calendar.dateComponents(
                    [.day], from: calendar.startOfDay(for: context.transactionDate),
                    to: calendar.startOfDay(for: candidate.capturedAt)
                ).day, abs(days) <= searchWindowDays
            else { return nil }

            let receiptLikelihood = receiptScore(candidate.classifications)
            let recognized = candidate.recognizedText.map {
                (
                    $0.text.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current),
                    $0.confidence
                )
            }
            let merchantMatch = merchantScore(context.merchant, recognized: recognized)
            let amountMatch = amountScore(context.amountInCents, recognized: recognized)
            let dateProximity = max(0, 1 - Double(abs(days)) / Double(searchWindowDays + 1))
            let total =
                receiptLikelihood * 0.45 + merchantMatch * 0.30 + amountMatch * 0.20
                + dateProximity * 0.05
            return NearbyReceiptCandidateScore(
                id: candidate.id, total: total, receiptLikelihood: receiptLikelihood,
                merchantMatch: merchantMatch, amountMatch: amountMatch, dateProximity: dateProximity)
        }
        .sorted {
            if $0.total != $1.total { return $0.total > $1.total }
            return $0.id < $1.id
        }
    }

    private static func receiptScore(_ classifications: [PhotoClassification]) -> Double {
        let labels = ["receipt", "document", "invoice", "credit_card", "menu"]
        return classifications.reduce(0) { current, classification in
            let identifier = classification.identifier.lowercased()
            guard labels.contains(where: identifier.contains) else { return current }
            return max(current, classification.confidence)
        }
    }

    private static func merchantScore(
        _ merchant: String?, recognized: [(text: String, confidence: Double)]
    ) -> Double {
        guard let merchant else { return 0 }
        let tokens = merchant.folding(
            options: [.caseInsensitive, .diacriticInsensitive], locale: .current
        ).split { !$0.isLetter && !$0.isNumber }.map(String.init).filter { $0.count >= 3 }
        guard !tokens.isEmpty else { return 0 }
        let matches = tokens.compactMap { token -> Double? in
            recognized.filter { $0.text.contains(token) }.map(\.confidence).max()
        }
        guard !matches.isEmpty else { return 0 }
        return matches.reduce(0, +) / Double(tokens.count)
    }

    private static func amountScore(
        _ cents: Int?, recognized: [(text: String, confidence: Double)]
    ) -> Double {
        guard let cents else { return 0 }
        let dollars = cents / 100
        let fractional = abs(cents % 100)
        let candidates = [
            String(format: "%d.%02d", dollars, fractional),
            String(format: "%d,%02d", dollars, fractional),
            String(format: "$%d.%02d", dollars, fractional),
        ]
        return recognized.filter { row in candidates.contains(where: row.text.contains) }
            .map(\.confidence).max() ?? 0
    }
}
