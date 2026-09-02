import CryptoKit
import Foundation
import PencilKit
import UIKit

enum PencilStrokeExporter {
    private static let parametricStep: CGFloat = 0.25

    /// Converts one completed PencilKit stroke to sampled points relative to the supplied origin.
    static func exportStroke(_ stroke: PKStroke, origin: CGPoint) -> NativeInkStroke? {
        let path = stroke.path
        guard path.count > 0 else { return nil }

        let lastParametricValue = CGFloat(path.count - 1)
        var parametricValue: CGFloat = 0
        var points: [NativeInkPoint] = []

        while parametricValue < lastParametricValue {
            points.append(exportPoint(
                path.interpolatedPoint(at: parametricValue),
                transform: stroke.transform,
                origin: origin
            ))
            parametricValue += parametricStep
        }
        points.append(exportPoint(
            path.interpolatedPoint(at: lastParametricValue),
            transform: stroke.transform,
            origin: origin
        ))

        guard !points.isEmpty else { return nil }
        let tool: NativeInkStroke.Tool = stroke.ink.inkType == .marker ? .highlighter : .pen
        let color = colorComponents(stroke.ink.color)
        let width = representativeWidth(path: path, tool: tool, transform: stroke.transform)
        let id = stableId(for: stroke)

        return NativeInkStroke(
            id: id,
            tool: tool,
            color: color.hex,
            width: width,
            opacity: tool == .highlighter ? min(color.alpha, 0.4) : color.alpha,
            points: points
        )
    }

    /// Identifies a PencilKit stroke without sampling its path or depending on viewport transforms.
    static func stableId(for stroke: PKStroke) -> String {
        let tool: NativeInkStroke.Tool = stroke.ink.inkType == .marker ? .highlighter : .pen
        return fingerprint(stroke: stroke, tool: tool, color: colorComponents(stroke.ink.color).hex)
    }

    /// Projects one PencilKit sample into the caller's local coordinate space.
    private static func exportPoint(
        _ point: PKStrokePoint,
        transform: CGAffineTransform,
        origin: CGPoint
    ) -> NativeInkPoint {
        let location = point.location.applying(transform)
        let pressure = point.force > 0 ? point.force : 0.5
        return NativeInkPoint(
            x: Double(location.x - origin.x),
            y: Double(location.y - origin.y),
            pressure: Double(max(0.05, min(1, pressure)))
        )
    }

    private static func representativeWidth(
        path: PKStrokePath,
        tool: NativeInkStroke.Tool,
        transform: CGAffineTransform
    ) -> Double {
        let sizes = (0..<path.count).map { index in
            let size = path[index].size
            return Double(max(size.width, size.height))
        }
        let average = sizes.reduce(0, +) / Double(max(1, sizes.count))
        let fallback = tool == .highlighter ? 14.0 : 4.0
        let transformed = average * Double(hypot(transform.a, transform.b))
        return max(0.5, min(64, transformed.isFinite && transformed > 0 ? transformed : fallback))
    }

    private static func colorComponents(_ color: UIColor) -> (hex: String, alpha: Double) {
        var red: CGFloat = 0
        var green: CGFloat = 0
        var blue: CGFloat = 0
        var alpha: CGFloat = 1
        guard color.getRed(&red, green: &green, blue: &blue, alpha: &alpha) else {
            return ("#1f1f24", 1)
        }

        return (
            String(
                format: "#%02X%02X%02X",
                Int(round(red * 255)),
                Int(round(green * 255)),
                Int(round(blue * 255))
            ),
            Double(alpha)
        )
    }

    private static func fingerprint(
        stroke: PKStroke,
        tool: NativeInkStroke.Tool,
        color: String
    ) -> String {
        var bytes = Data()
        append(stroke.path.creationDate.timeIntervalSince1970, to: &bytes)
        append(UInt64(stroke.randomSeed), to: &bytes)
        bytes.append(contentsOf: tool.rawValue.utf8)
        bytes.append(contentsOf: color.utf8)
        return SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
    }

    private static func append(_ value: Double, to data: inout Data) {
        append(value.bitPattern, to: &data)
    }

    private static func append(_ value: UInt64, to data: inout Data) {
        var bigEndian = value.bigEndian
        withUnsafeBytes(of: &bigEndian) { data.append(contentsOf: $0) }
    }
}
