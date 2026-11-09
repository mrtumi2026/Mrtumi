# Mr. Tumi Grocery & Gifts — iOS Native Application

Official iOS application for Mr. Tumi Multi-Vendor Marketplace, built with Swift 5 and SwiftUI for iOS 15.0+ (iOS 15, 16, 17, 18+).

---

## 🚀 Key Features

1. **Instant Auto-Update Architecture (Zero App-Store Delay):**
   - Built on `WKWebView` with `.useProtocolCachePolicy` and `reloadFromOrigin()`.
   - Any website changes, new products, flash sales, price updates, or design adjustments on `mrtumi.com` **immediately reflect inside the app** without requiring users to download an update from the Apple App Store.
2. **Smooth Pull-To-Refresh:**
   - Native `UIRefreshControl` with Mr. Tumi Brand Red theme (`#dc2626`).
   - Forces origin reload to fetch fresh content instantly.
3. **Smart Network Monitoring & Offline Fallback:**
   - Uses `NWPathMonitor` for real-time connection status.
   - If connection drops, shows a clean, branded offline screen with an auto-retry and a manual retry button.
   - Automatically reloads the web application the moment connection is restored.
4. **Push Notifications (Apple APNs):**
   - Full integration with Apple Push Notification service (APNs).
   - Automated registration with backend (`POST /api/device/register-token` with `platform: 'ios'`).
   - Deep-linking support for order tracking (`/track-order?invoice=...`) and promotional campaigns (`/campaign/...`).
5. **App Store Guidelines Compliance:**
   - Permissions configured in `Info.plist` for Camera (`NSCameraUsageDescription`) and Photos (`NSPhotoLibraryUsageDescription`) to allow product review and dispute photo uploads.
   - Supports external app protocols (`tel:`, `mailto:`, `whatsapp:`, `sms:`) and Bangladeshi MFS apps (bKash, Nagad).
   - Encryption exemption flag (`ITSAppUsesNonExemptEncryption = false`).

---

## 🛠️ How to Open & Build with Xcode on macOS

1. Transfer or clone the repository to your Mac:
   ```bash
   git clone https://github.com/mrtumi2026/Mrtumi.git
   cd Mrtumi/ios
   ```
2. Double-click `MrTumi.xcodeproj` to open it in **Xcode**.
3. Select your development team in **Signing & Capabilities**.
4. Choose an iPhone Simulator (e.g., iPhone 15 Pro, iOS 17+) and press **Cmd + R** to run.
5. To generate an Archive for TestFlight / App Store:
   - Go to menu: **Product** > **Archive**
   - Click **Distribute App** > **App Store Connect** / **TestFlight**.
