import Foundation

extension JSONValue {
    /// Evaluates a manifest `display.labelPath` / `readPath` against this row: dotted keys, `[n]`
    /// indexing, and a `[]` projection that maps the rest of the path over an array. Mirrors
    /// `apps/web/src/entity/read-path.ts`; a missing link anywhere reads as `nil`.
    public func pathValue(_ path: String) -> JSONValue? {
        var steps = Self.pathSteps(path)[...]
        return walk(&steps)
    }

    /// The text a row carries at `path`: a string as is, a number or boolean spelled plainly, and
    /// a projected array joined with ", ". Empty text is absent.
    public func pathText(_ path: String) -> String? {
        guard let value = pathValue(path) else { return nil }
        let text: String?
        switch value {
        case .string(let string): text = string
        case .number(let number):
            text = number == number.rounded() && abs(number) < 1e15 ? String(Int(number)) : String(number)
        case .bool(let flag): text = flag ? "true" : "false"
        case .array(let items):
            text = items.compactMap { $0.pathText("") }.joined(separator: ", ")
        case .null, .object: text = nil
        }
        guard let text, !text.isEmpty else { return nil }
        return text
    }

    private enum PathStep: Equatable {
        case key(String)
        case index(Int)
        case each
    }

    private static func pathSteps(_ path: String) -> [PathStep] {
        var steps: [PathStep] = []
        var buffer = ""
        var insideBracket = false
        func flushKey() {
            if !buffer.isEmpty { steps.append(.key(buffer)) }
            buffer = ""
        }
        for character in path {
            switch character {
            case "." where !insideBracket: flushKey()
            case "[":
                flushKey()
                insideBracket = true
            case "]":
                steps.append(buffer.isEmpty ? .each : .index(Int(buffer) ?? -1))
                buffer = ""
                insideBracket = false
            default: buffer.append(character)
            }
        }
        flushKey()
        return steps
    }

    private func walk(_ steps: inout ArraySlice<PathStep>) -> JSONValue? {
        guard let step = steps.popFirst() else { return self }
        switch step {
        case .key(let key):
            guard let next = self[key], next != .null else { return nil }
            return next.walk(&steps)
        case .index(let index):
            guard let next = self[index], next != .null else { return nil }
            return next.walk(&steps)
        case .each:
            guard let items = arrayValue else { return nil }
            let rest = steps
            return .array(
                items.compactMap { item in
                    var remaining = rest
                    return item.walk(&remaining)
                })
        }
    }
}
