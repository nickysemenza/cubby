import CubbyKit
import Foundation

extension CLI {
    /// Only response diagnostics enter this formatter; request bodies and credential snapshots
    /// must never be passed in. Preserve unknown diagnostic extensions when typed decoding fails.
    static func apiErrorMessage(_ error: CubbyAPIError) -> String {
        let code = error.detail?.code ?? "HTTP_ERROR"
        let rawText = String(decoding: error.rawBody, as: UTF8.self)
        let response = try? JSONSerialization.jsonObject(with: error.rawBody, options: [.fragmentsAllowed])
        let message =
            error.detail?.message ?? (rawText.isEmpty || response != nil ? "Request failed" : rawText)
        var lines = ["HTTP \(error.status) \(code): \(message)", "operation: \(error.operationID)"]
            .map(scrubDiagnosticText)
        var details: [String: Any] = [:]
        if let detail = error.detail {
            details["reason"] = detail.reason
            details["requestId"] = detail.requestId
            details["validationIssues"] = detail.validationIssues?.map {
                ["code": $0.code, "path": $0.path, "message": $0.message] as [String: Any]
            }
            if let diagnostic = detail.diagnostics {
                var fields: [String: Any] = [
                    "origin": diagnostic.origin, "operation": diagnostic.operation,
                    "stage": diagnostic.stage,
                    "causes": diagnostic.causes.map { cause -> [String: Any] in
                        var fields: [String: Any] = ["name": cause.name, "message": cause.message]
                        fields["stack"] = cause.stack
                        fields["code"] = cause.code
                        fields["status"] = cause.status
                        return fields
                    },
                ]
                fields["entity"] = diagnostic.entity
                fields["module"] = diagnostic.module
                fields["truncated"] = diagnostic.truncated
                fields["batchIndex"] = diagnostic.batchIndex
                fields["sentryEventId"] = diagnostic.sentryEventId
                fields["sentryUrl"] = diagnostic.sentryUrl
                fields["cfRayId"] = diagnostic.cfRayId
                fields["cloudflareUrl"] = diagnostic.cloudflareUrl
                details["diagnostics"] = fields
            }
        }
        if let object = response as? [String: Any] {
            // An error response may echo input alongside its diagnostics. Do not print that input.
            for key in ["code", "message", "reason", "requestId", "validationIssues", "diagnostics", "error"]
            {
                if let value = object[key] { details[key] = value }
            }
        } else if let text = response as? String {
            details["message"] = text
        }
        if !details.isEmpty,
            let data = try? JSONSerialization.data(
                withJSONObject: scrubDiagnosticValue(details),
                options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes])
        {
            lines.append(String(decoding: data, as: UTF8.self))
        }
        return lines.joined(separator: "\n")
    }

    private static func scrubDiagnosticValue(_ value: Any, inRequest: Bool = false) -> Any {
        if let object = value as? [String: Any] {
            return object.reduce(into: [String: Any]()) { result, entry in
                let key = entry.key.lowercased().replacingOccurrences(of: "_", with: "")
                    .replacingOccurrences(of: "-", with: "")
                if [
                    "password", "passwd", "secret", "apikey", "token", "accesstoken", "refreshtoken",
                    "authorization", "cookie", "setcookie", "setauthtoken", "credential", "credentials",
                    "requestbody", "requestpayload", "jsonbody",
                ].contains(key)
                    || (inRequest && ["body", "input", "payload", "headers"].contains(key))
                {
                    result[entry.key] = "[REDACTED]"
                } else {
                    // A response body is evidence. Only known request ancestors mark body/input
                    // as echoed request content; the same names inside responses remain visible.
                    let request = inRequest || ["request", "httprequest"].contains(key)
                    if ["request", "httprequest"].contains(key) && entry.value is String {
                        result[entry.key] = "[REDACTED]"
                    } else {
                        result[entry.key] = scrubDiagnosticValue(entry.value, inRequest: request)
                    }
                }
            }
        }
        if let array = value as? [Any] { return array.map { scrubDiagnosticValue($0, inRequest: inRequest) } }
        if let text = value as? String { return scrubDiagnosticText(text) }
        return value
    }

    private static func scrubDiagnosticText(_ text: String) -> String {
        // Decode complete and embedded JSON strings before matching credentials, including
        // escaped property names and strings containing another JSON-encoded diagnostic.
        if let parsed = try? JSONSerialization.jsonObject(with: Data(text.utf8)),
            let original = try? JSONSerialization.data(withJSONObject: parsed, options: [.sortedKeys]),
            let scrubbed = try? JSONSerialization.data(
                withJSONObject: scrubDiagnosticValue(parsed), options: [.sortedKeys]),
            original != scrubbed
        {
            return String(decoding: scrubbed, as: UTF8.self)
        }
        let decoded = replacingDiagnosticMatches(text, pattern: #""(?:[^"\\]|\\[\s\S])*""#) { encoded in
            guard let value = try? JSONDecoder().decode(String.self, from: Data(encoded.utf8))
            else { return encoded }
            let scrubbed = scrubDiagnosticText(value)
            guard scrubbed != value, let data = try? JSONEncoder().encode(scrubbed) else { return encoded }
            return String(decoding: data, as: UTF8.self)
        }
        // Keep these credential families aligned with worker-tracing/scrub-error-message.ts.
        let paginationToken =
            #"[\w-]*(?:page|next|prev|previous|continuation|pagination|sync|cursor)[_-]?token"#
        let labels =
            #"(?:password|passwd|secret|api_?key|token|access_token|refresh_token|authorization|cookie|set-cookie)"#
        let value = #"[^\s,;}&"'<>]"#
        let replacements: [(String, String)] = [
            (
                #"(?im)(\bauthorization\s*:\s*)(?:Bearer|Token|OAuth|Negotiate)\s+[^\s;,"']+"#,
                "$1[REDACTED]"
            ),
            (#"(?im)\b(?:set-)?cookie\s*:\s*[^\s=;]+=[^\r\n]+"#, "[REDACTED]"),
            (#"(?i)\b(Bearer)\s+[A-Za-z0-9.+/=_-]{16,}"#, "$1 [REDACTED]"),
            (#"(?i)([a-z][a-z0-9+.-]{0,30}://)[^\s/@]+:[^\s/@]+@"#, "$1[REDACTED]@"),
            (
                #"(?i)([?&](?!"# + paginationToken
                    + #"=)(?:key|sig|(?:[\w.-]*[_-])?(?:api_?key|token|secret|password|signature|credential))=)[^\s&#"'<>]*"#,
                "$1[REDACTED]"
            ),
            (
                #"\b(?:sk-(?:[A-Za-z\d]{20,}|(?:ant|proj)-[\w-]{20,})|[sr]k_(?:live|test)_[A-Za-z\d]{16,}|gh[pousr]_[A-Za-z\d]{30,}|github_pat_\w{30,}|AKIA[\dA-Z]{16}(?![\w-])|AIza[\w-]{35}(?![\w-])|xox[abprs]-[A-Za-z\d-]{10,}|eyJ[\w-]{8,}\.eyJ[\w-]{8,}\.[\w-]+)"#,
                "[REDACTED]"
            ),
            (
                #"(?i)(?<![\w-])("# + labels + #"["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')"#,
                "$1[REDACTED]"
            ),
            (
                #"(?i)(?<![\w-])("# + labels + #"["']?\s*=\s*)(?!\$\d+\b)"# + value + "+",
                "$1[REDACTED]"
            ),
            (
                #"(?i)(?<![\w-])((?:password|passwd)["']?\s*:\s*)(?!\$\d+\b)"# + value + "+",
                "$1[REDACTED]"
            ),
            (
                #"(?i)(?<![\w-])("# + labels + #"["']?\s*:\s*)(?!\$\d+\b)(?="# + value + #"*[\d_.+/=-])"#
                    + value + "{6,}",
                "$1[REDACTED]"
            ),
            (#"(?im)\b(request\s+(?:body|payload)\s*[:=]\s*)[^\r\n]+"#, "$1[REDACTED]"),
        ]
        let scrubbed = replacements.reduce(decoded) { result, replacement in
            result.replacingOccurrences(
                of: replacement.0, with: replacement.1, options: .regularExpression)
        }
        // "Basic" also occurs in ordinary diagnostic prose; a Basic credential decodes to user:password.
        guard let basic = try? NSRegularExpression(pattern: #"(?i)\bBasic\s+([A-Za-z0-9+/]{4,}={0,2})"#)
        else { return scrubbed }
        return basic.matches(in: scrubbed, range: NSRange(scrubbed.startIndex..., in: scrubbed))
            .reversed().reduce(scrubbed) { result, match in
                let value = (scrubbed as NSString).substring(with: match.range(at: 1))
                guard let bytes = Data(base64Encoded: value),
                    String(decoding: bytes, as: UTF8.self).contains(":"),
                    let range = Range(match.range(at: 1), in: result)
                else { return result }
                return result.replacingCharacters(in: range, with: "[REDACTED]")
            }
    }

    private static func replacingDiagnosticMatches(
        _ text: String, pattern: String, transform: (String) -> String
    ) -> String {
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return text }
        return regex.matches(in: text, range: NSRange(text.startIndex..., in: text))
            .reversed().reduce(text) { result, match in
                guard let range = Range(match.range, in: result) else { return result }
                return result.replacingCharacters(
                    in: range, with: transform((text as NSString).substring(with: match.range)))
            }
    }
}
