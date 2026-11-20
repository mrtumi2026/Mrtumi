//
//  MrTumiApp.swift
//  MrTumi
//
//  Mr. Tumi Marketplace & Grocery - iOS Native Storefront
//  Supports iOS 15.0+ (iOS 15, 16, 17, 18+)
//

import SwiftUI
import UserNotifications

@main
struct MrTumiApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) var appDelegate
    @StateObject private var webViewModel = WebViewModel()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(webViewModel)
                .onOpenURL { url in
                    webViewModel.handleIncomingUrl(url)
                }
        }
    }
}

class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        UNUserNotificationCenter.current().delegate = self

        // Request Push Notification Authorization
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { granted, error in
            if granted {
                DispatchQueue.main.async {
                    application.registerForRemoteNotifications()
                }
            }
        }

        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        let tokenParts = deviceToken.map { data in String(format: "%02.2hhx", data) }
        let token = tokenParts.joined()
        print("[MrTumi APNs] Device Token: \(token)")
        
        // Register token with Mr. Tumi backend
        PushNotificationService.shared.registerDeviceToken(token: token, platform: "ios")
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        print("[MrTumi APNs] Failed to register: \(error.localizedDescription)")
    }

    // Handle notification when app is in foreground
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound, .badge])
    }

    // Handle notification tap / action
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let userInfo = response.notification.request.content.userInfo
        if let deepLink = userInfo["deep_link"] as? String,
           let url = URL(string: deepLink.hasPrefix("http") ? deepLink : "https://mrtumi.com" + deepLink) {
            DispatchQueue.main.async {
                NotificationCenter.default.post(name: .mrtumiNavigateDeepLink, object: url)
            }
        }
        completionHandler()
    }
}

extension Notification.Name {
    static let mrtumiNavigateDeepLink = Notification.Name("mrtumiNavigateDeepLink")
}
