//
//  WebViewContainer.swift
//  MrTumi
//
//  WKWebView Wrapper with Auto-Update Protocol, JavaScript Bridge,
//  Pull-to-Refresh and Deep Linking.
//

import SwiftUI
import WebKit

class WebViewModel: NSObject, ObservableObject {
    @Published var isLoading: Bool = false
    @Published var loadingProgress: Double = 0.0
    @Published var isErrorOccurred: Bool = false
    @Published var hasLoadedOnce: Bool = false

    weak var webView: WKWebView?
    let defaultHomeUrl = URL(string: "https://mrtumi.com")!

    func loadUrl(_ url: URL) {
        var request = URLRequest(url: url)
        // Protocol Cache Policy: Always revalidates HTML with server so updates are instant
        request.cachePolicy = .useProtocolCachePolicy
        request.timeoutInterval = 20
        webView?.load(request)
    }

    func reload() {
        isErrorOccurred = false
        // Force reload from origin server (bypasses stale cached HTML)
        webView?.reloadFromOrigin()
    }

    func handleIncomingUrl(_ url: URL) {
        if url.scheme == "mrtumi" {
            // Custom scheme deep link: mrtumi://product/fresh-lychee
            let relativePath = url.host ?? "" + url.path
            if let target = URL(string: "https://mrtumi.com/" + relativePath) {
                loadUrl(target)
            }
        } else if url.host?.contains("mrtumi.com") == true {
            loadUrl(url)
        }
    }
}

struct WebViewContainer: UIViewRepresentable {
    @ObservedObject var webViewModel: WebViewModel

    func makeCoordinator() -> Coordinator {
        Coordinator(self)
    }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.allowsInlineMediaPlayback = true
        
        // Native JavaScript Bridge Injection
        let userContentController = WKUserContentController()
        let bridgeScriptSource = """
        window.MrtumiNativeBridge = {
            platform: 'ios',
            isNativeApp: true,
            postMessage: function(msg) {
                if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.mrtumiBridge) {
                    window.webkit.messageHandlers.mrtumiBridge.postMessage(msg);
                }
            },
            share: function(title, url) {
                this.postMessage({ action: 'share', title: title, url: url });
            }
        };
        """
        let userScript = WKUserScript(
            source: bridgeScriptSource,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: false
        )
        userContentController.addUserScript(userScript)
        userContentController.add(context.coordinator, name: "mrtumiBridge")
        configuration.userContentController = userContentController

        // WKWebView initialization with modern preferences
        let preferences = WKWebpagePreferences()
        preferences.allowsContentJavaScript = true
        configuration.defaultWebpagePreferences = preferences

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator
        webView.allowsBackForwardNavigationGestures = true
        webView.scrollView.bounces = true

        // Pull to Refresh (UIRefreshControl)
        let refreshControl = UIRefreshControl()
        refreshControl.tintColor = UIColor(red: 0.86, green: 0.15, blue: 0.15, alpha: 1.0)
        refreshControl.addTarget(context.coordinator, action: #selector(Coordinator.handleRefresh(_:)), for: .valueChanged)
        webView.scrollView.refreshControl = refreshControl

        // Progress & Loading Observers
        context.coordinator.setupObservers(for: webView)
        webViewModel.webView = webView

        // Initial Load (Auto-update enabled: always fetches latest version from mrtumi.com)
        var request = URLRequest(url: webViewModel.defaultHomeUrl)
        request.cachePolicy = .useProtocolCachePolicy
        webView.load(request)

        return webView
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}

    class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
        var parent: WebViewContainer
        private var progressObservation: NSKeyValueObservation?
        private var loadingObservation: NSKeyValueObservation?

        init(_ parent: WebViewContainer) {
            self.parent = parent
        }

        func setupObservers(for webView: WKWebView) {
            progressObservation = webView.observe(\.estimatedProgress, options: .new) { [weak self] webView, _ in
                DispatchQueue.main.async {
                    self?.parent.webViewModel.loadingProgress = webView.estimatedProgress
                }
            }
            loadingObservation = webView.observe(\.isLoading, options: .new) { [weak self] webView, _ in
                DispatchQueue.main.async {
                    self?.parent.webViewModel.isLoading = webView.isLoading
                    if !webView.isLoading {
                        webView.scrollView.refreshControl?.endRefreshing()
                    }
                }
            }
        }

        @objc func handleRefresh(_ refreshControl: UIRefreshControl) {
            // Reload directly from origin to ensure new products / banners / layout are instantly refreshed
            parent.webViewModel.reload()
        }

        // Handle external protocols (tel:, mailto:, whatsapp:, bkash:, etc.)
        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
        ) {
            guard let url = navigationAction.request.url else {
                decisionHandler(.cancel)
                return
            }

            let scheme = url.scheme?.lowercased() ?? ""

            // External Apps Handling
            if scheme == "tel" || scheme == "mailto" || scheme == "sms" || scheme == "whatsapp" {
                if UIApplication.shared.canOpenURL(url) {
                    UIApplication.shared.open(url, options: [:], completionHandler: nil)
                }
                decisionHandler(.cancel)
                return
            }

            // MFS Payment App Links (e.g. bKash / Nagad deep link URLs)
            if scheme != "http" && scheme != "https" && scheme != "about" {
                if UIApplication.shared.canOpenURL(url) {
                    UIApplication.shared.open(url, options: [:], completionHandler: nil)
                    decisionHandler(.cancel)
                    return
                }
            }

            decisionHandler(.allow)
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            DispatchQueue.main.async {
                self.parent.webViewModel.hasLoadedOnce = true
                self.parent.webViewModel.isErrorOccurred = false
            }
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            let nsError = error as NSError
            if nsError.code != NSURLErrorCancelled {
                DispatchQueue.main.async {
                    self.parent.webViewModel.isErrorOccurred = true
                }
            }
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            let nsError = error as NSError
            if nsError.code != NSURLErrorCancelled {
                DispatchQueue.main.async {
                    self.parent.webViewModel.isErrorOccurred = true
                }
            }
        }

        // JavaScript Bridge Message Handler
        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard message.name == "mrtumiBridge", let dict = message.body as? [String: Any] else { return }
            
            let action = dict["action"] as? String ?? ""
            if action == "share", let shareUrl = dict["url"] as? String {
                let title = dict["title"] as? String ?? "Mr. Tumi"
                let activityVC = UIActivityViewController(activityItems: [title, shareUrl], applicationActivities: nil)
                if let windowScene = UIApplication.shared.connectedScenes.first as? UIWindowScene,
                   let rootVC = windowScene.windows.first?.rootViewController {
                    rootVC.present(activityVC, animated: true)
                }
            }
        }
    }
}
