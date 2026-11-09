//
//  ContentView.swift
//  MrTumi
//
//  Main Storefront View with WKWebView, Pull-to-Refresh,
//  Instant Auto-Update, and Offline Handling.
//

import SwiftUI

struct ContentView: View {
    @EnvironmentObject var webViewModel: WebViewModel
    @StateObject private var networkMonitor = NetworkMonitor()

    var body: some View {
        ZStack(alignment: .top) {
            // Main WebView
            if networkMonitor.isConnected || webViewModel.hasLoadedOnce {
                WebViewContainer(webViewModel: webViewModel)
                    .ignoresSafeArea(.keyboard, edges: .bottom)
            } else {
                // Offline Fallback View
                OfflineFallbackView {
                    webViewModel.reload()
                }
            }

            // Top Progress Bar for page navigation
            if webViewModel.isLoading {
                ProgressView(value: webViewModel.loadingProgress, total: 1.0)
                    .progressViewStyle(LinearProgressViewStyle(tint: Color(red: 0.86, green: 0.15, blue: 0.15))) // Mr. Tumi Red #dc2626
                    .frame(height: 3)
                    .animation(.easeInOut, value: webViewModel.loadingProgress)
            }
        }
        .onAppear {
            networkMonitor.onConnected = {
                if webViewModel.isErrorOccurred {
                    webViewModel.reload()
                }
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .mrtumiNavigateDeepLink)) { notification in
            if let url = notification.object as? URL {
                webViewModel.loadUrl(url)
            }
        }
    }
}

// Branded Offline Screen
struct OfflineFallbackView: View {
    var onRetry: () -> Void

    var body: some View {
        VStack(spacing: 20) {
            Spacer()

            Image(systemName: "wifi.slash")
                .resizable()
                .scaledToFit()
                .frame(width: 72, height: 72)
                .foregroundColor(Color(red: 0.86, green: 0.15, blue: 0.15))

            Text("ইন্টারনেট সংযোগ নেই")
                .font(.title2)
                .fontWeight(.bold)
                .foregroundColor(.primary)

            Text("আপনার ফোনের ইন্টারনেট অথবা ওয়াইফাই সংযোগ পরীক্ষা করে পুনরায় চেষ্টা করুন।")
                .font(.body)
                .multilineTextAlignment(.center)
                .foregroundColor(.secondary)
                .padding(.horizontal, 32)

            Button(action: onRetry) {
                HStack {
                    Image(systemName: "arrow.clockwise")
                    Text("আবার চেষ্টা করুন")
                }
                .fontWeight(.semibold)
                .padding(.horizontal, 28)
                .padding(.vertical, 14)
                .background(Color(red: 0.86, green: 0.15, blue: 0.15))
                .foregroundColor(.white)
                .cornerRadius(12)
                .shadow(color: Color.black.opacity(0.15), radius: 6, x: 0, y: 3)
            }
            .padding(.top, 12)

            Spacer()

            Text("Mr. Tumi Grocery & Gifts")
                .font(.footnote)
                .foregroundColor(.gray)
                .padding(.bottom, 16)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(UIColor.systemBackground))
    }
}
