import XCTest
import WebKit
@testable import Dim0Native

@MainActor
final class LocalPairingTests: XCTestCase {
    func testOnlyPrivateHTTPSAddressesAreAccepted() {
        for value in ["https://192.168.1.2:54321", "https://10.0.0.2:54321", "https://172.16.0.2:54321"] {
            XCTAssertNotNil(LocalPairingBridge.endpoint(value), value)
        }
        for value in ["http://192.168.1.2:54321", "https://127.0.0.1:54321", "https://8.8.8.8:54321", "https://example.com:54321",
                      "https://192.168.1.2:54321/path", "https://user@192.168.1.2:54321", "https://192.168.1.2:54321?url=x",
                      "https://192.168.1.2", "https://192.168.1.2:443", "https://172.32.0.2:54321", "file:///etc/passwd"] {
            XCTAssertNil(LocalPairingBridge.endpoint(value), value)
        }
    }

    /// Simulated responses must retain the HTTPS origin, and its saved browser data, after a reload.
    func testOfflineHTMLKeepsExistingOriginAndStorage() async throws {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        let view = WKWebView(frame: .zero, configuration: configuration)
        let request = URLRequest(url: Dim0WebAppConfiguration.appURL)
        let first = NavigationWaiter()
        view.navigationDelegate = first
        view.loadSimulatedRequest(request, responseHTML: "<html><body>First</body></html>")
        await fulfillment(of: [first.loaded], timeout: 15)
        _ = try await view.evaluateJavaScript("localStorage.setItem('offline-origin-test', 'saved'); location.origin")
        _ = try await view.callAsyncJavaScript("""
            const db = await new Promise((resolve, reject) => {
              const r = indexedDB.open('offline-origin-test', 1);
              r.onupgradeneeded = () => r.result.createObjectStore('boards');
              r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
            });
            const tx = db.transaction('boards', 'readwrite');
            tx.objectStore('boards').put({title: 'Existing drawing'}, 'old-board');
            await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
            db.close(); return true;
            """, arguments: [:], in: nil, contentWorld: .page)
        let next = NavigationWaiter()
        view.navigationDelegate = next
        view.loadSimulatedRequest(request, responseHTML: "<html><body>Offline</body></html>")
        await fulfillment(of: [next.loaded], timeout: 15)
        let value = try await view.evaluateJavaScript("localStorage.getItem('offline-origin-test')") as? String
        XCTAssertEqual(value, "saved")
        let title = try await view.callAsyncJavaScript("""
            const db = await new Promise((resolve, reject) => {
              const r = indexedDB.open('offline-origin-test', 1);
              r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
            });
            const value = await new Promise((resolve, reject) => {
              const r = db.transaction('boards').objectStore('boards').get('old-board');
              r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
            });
            db.close(); return value.title;
            """, arguments: [:], in: nil, contentWorld: .page) as? String
        XCTAssertEqual(title, "Existing drawing")
        let origin = try await view.evaluateJavaScript("location.origin") as? String
        XCTAssertEqual(origin, "https://\(try XCTUnwrap(Dim0WebAppConfiguration.appURL.host))")
    }
}

@MainActor
private final class NavigationWaiter: NSObject, WKNavigationDelegate {
    let loaded = XCTestExpectation(description: "Simulated HTML loaded")
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { loaded.fulfill() }
}
