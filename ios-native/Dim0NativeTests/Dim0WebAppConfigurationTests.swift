import Foundation
import XCTest
@testable import Dim0Native

final class Dim0WebAppConfigurationTests: XCTestCase {
    /// Production navigation requires TLS, while development HTTP stays local.
    func testAllowedWebURLPolicy() throws {
        XCTAssertTrue(Dim0WebAppConfiguration.isAllowedWebURL(
            try XCTUnwrap(URL(string: "https://app.dim0.net/local/board"))
        ))
        XCTAssertTrue(Dim0WebAppConfiguration.isAllowedWebURL(
            try XCTUnwrap(URL(string: "http://192.168.1.20:5175"))
        ))
        XCTAssertTrue(Dim0WebAppConfiguration.isAllowedWebURL(
            try XCTUnwrap(URL(string: "http://dim0.local:5175"))
        ))
        XCTAssertFalse(Dim0WebAppConfiguration.isAllowedWebURL(
            try XCTUnwrap(URL(string: "http://example.com"))
        ))
        XCTAssertFalse(Dim0WebAppConfiguration.isAllowedWebURL(
            try XCTUnwrap(URL(string: "file:///tmp/index.html"))
        ))
    }

    /// Manual native snapshots retain their board context across bridge round trips.
    func testSnapshotRoundTrip() throws {
        let message = NativePencilInkSnapshot(
            sessionId: "ad7dbd1d-7235-49c9-854f-c00613504eae",
            contextId: "board:folder",
            camera: NativePencilCamera(x: 0, y: 0, zoom: 1),
            strokes: [NativeInkStroke(
                id: String(repeating: "a", count: 64),
                tool: .pen,
                color: "#123456",
                width: 5,
                opacity: 1,
                points: [NativeInkPoint(x: 1, y: 2, pressure: 0.5)]
            )]
        )

        let restored = try JSONDecoder().decode(
            NativePencilInkSnapshot.self,
            from: JSONEncoder().encode(message)
        )

        XCTAssertEqual(restored, message)
    }

    func testPencilDocumentStoreSeparatesBoardContexts() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = NativePencilDocumentStore(baseDirectory: directory)
        let first = NativePencilDocument(
            drawing: Data([1, 2, 3]),
            camera: NativePencilCamera(x: 10, y: 20, zoom: 2),
            strokeColors: [String(repeating: "a", count: 64): "#123456"]
        )
        let second = NativePencilDocument(
            drawing: Data([4, 5]),
            camera: NativePencilCamera(x: -2, y: 3, zoom: 0.5),
            strokeColors: [:]
        )

        try await store.save(first, contextId: "board-a:")
        try await store.save(second, contextId: "board-b:folder")

        let restoredFirst = try await store.load(contextId: "board-a:")
        let restoredSecond = try await store.load(contextId: "board-b:folder")
        XCTAssertEqual(restoredFirst, first)
        XCTAssertEqual(restoredSecond, second)
    }
}
