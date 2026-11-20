# Proguard rules for Mr. Tumi WebView Apps
-keepattributes *Annotation*
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
