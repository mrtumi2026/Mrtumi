package com.mrtumi.store;

import android.annotation.SuppressLint;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.net.ConnectivityManager;
import android.net.NetworkInfo;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.Toast;

import androidx.activity.OnBackPressedCallback;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.appcompat.app.AppCompatActivity;
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout;

import com.google.firebase.messaging.FirebaseMessaging;

public class MainActivity extends AppCompatActivity {

    public static final String DEFAULT_URL = "https://mrtumi.com";
    private WebView webView;
    private SwipeRefreshLayout swipeRefresh;
    private ProgressBar progressBar;
    private LinearLayout layoutOffline;
    private Button btnRetry;

    private ValueCallback<Uri[]> fileUploadCallback;
    private ActivityResultLauncher<Intent> fileChooserLauncher;
    private long lastBackPressTime = 0;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        webView = findViewById(R.id.webView);
        swipeRefresh = findViewById(R.id.swipeRefresh);
        progressBar = findViewById(R.id.progressBar);
        layoutOffline = findViewById(R.id.layoutOffline);
        btnRetry = findViewById(R.id.btnRetry);

        setupFileChooser();
        setupWebView();
        setupSwipeRefresh();
        setupBackButton();
        setupPushNotifications();

        btnRetry.setOnClickListener(v -> {
            if (isNetworkAvailable()) {
                layoutOffline.setVisibility(View.GONE);
                webView.setVisibility(View.VISIBLE);
                webView.reload();
            } else {
                Toast.makeText(this, "ইন্টারনেট সংযোগ পাওয়া যায়নি। পুনরায় চেষ্টা করুন।", Toast.LENGTH_SHORT).show();
            }
        });

        // Handle initial intent or deep link
        String targetUrl = DEFAULT_URL;
        if (getIntent() != null && getIntent().getData() != null) {
            targetUrl = getIntent().getData().toString();
        } else if (getIntent() != null && getIntent().hasExtra("deep_link")) {
            String deep = getIntent().getStringExtra("deep_link");
            if (deep != null && deep.startsWith("/")) {
                targetUrl = DEFAULT_URL + deep;
            } else if (deep != null && deep.startsWith("http")) {
                targetUrl = deep;
            }
        }

        if (isNetworkAvailable()) {
            webView.loadUrl(targetUrl);
        } else {
            showOfflineView();
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void setupWebView() {
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(true);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        settings.setSupportZoom(false);
        settings.setMediaPlaybackRequiresUserGesture(false);

        // Custom User Agent identifier
        String defaultUa = settings.getUserAgentString();
        settings.setUserAgentString(defaultUa + " MrTumiAndroidApp/1.0.0");

        webView.addJavascriptInterface(new MrtumiNativeBridge(this), "MrtumiApp");

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageStarted(WebView view, String url, Bitmap favicon) {
                super.onPageStarted(view, url, favicon);
                progressBar.setVisibility(View.VISIBLE);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                progressBar.setVisibility(View.GONE);
                swipeRefresh.setRefreshing(false);
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) {
                    showOfflineView();
                }
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                String scheme = uri.getScheme();

                // Handle external protocols (WhatsApp, Phone Call, Mail, bKash)
                if ("tel".equals(scheme) || "mailto".equals(scheme) || "sms".equals(scheme)) {
                    Intent intent = new Intent(Intent.ACTION_VIEW, uri);
                    startActivity(intent);
                    return true;
                }
                if (uri.getHost() != null && !uri.getHost().contains("mrtumi.com") && !uri.getHost().contains("localhost")) {
                    Intent externalIntent = new Intent(Intent.ACTION_VIEW, uri);
                    startActivity(externalIntent);
                    return true;
                }
                return false;
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView view, int newProgress) {
                progressBar.setProgress(newProgress);
                if (newProgress == 100) {
                    progressBar.setVisibility(View.GONE);
                } else {
                    progressBar.setVisibility(View.VISIBLE);
                }
            }

            @Override
            public boolean onShowFileChooser(WebView webView, ValueCallback<Uri[]> filePathCallback, FileChooserParams fileChooserParams) {
                if (fileUploadCallback != null) {
                    fileUploadCallback.onReceiveValue(null);
                }
                fileUploadCallback = filePathCallback;

                Intent intent = fileChooserParams.createIntent();
                try {
                    fileChooserLauncher.launch(intent);
                } catch (Exception e) {
                    fileUploadCallback = null;
                    return false;
                }
                return true;
            }
        });
    }

    private void setupFileChooser() {
        fileChooserLauncher = registerForActivityResult(
                new ActivityResultContracts.StartActivityForResult(),
                result -> {
                    if (fileUploadCallback == null) return;
                    Uri[] results = null;
                    if (result.getResultCode() == RESULT_OK && result.getData() != null) {
                        if (result.getData().getClipData() != null) {
                            int count = result.getData().getClipData().getItemCount();
                            results = new Uri[count];
                            for (int i = 0; i < count; i++) {
                                results[i] = result.getData().getClipData().getItemAt(i).getUri();
                            }
                        } else if (result.getData().getData() != null) {
                            results = new Uri[]{result.getData().getData()};
                        }
                    }
                    fileUploadCallback.onReceiveValue(results);
                    fileUploadCallback = null;
                }
        );
    }

    private void setupSwipeRefresh() {
        swipeRefresh.setColorSchemeResources(R.color.brand_forest, R.color.brand_gold);
        swipeRefresh.setOnRefreshListener(() -> {
            if (isNetworkAvailable()) {
                webView.reload();
            } else {
                swipeRefresh.setRefreshing(false);
                showOfflineView();
            }
        });
    }

    private void setupBackButton() {
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (webView.canGoBack()) {
                    webView.goBack();
                } else {
                    long now = System.currentTimeMillis();
                    if (now - lastBackPressTime < 2000) {
                        finish();
                    } else {
                        lastBackPressTime = now;
                        Toast.makeText(MainActivity.this, "অ্যাপ বন্ধ করতে পুনরায় চাপুন", Toast.LENGTH_SHORT).show();
                    }
                }
            }
        });
    }

    private void setupPushNotifications() {
        FirebaseMessaging.getInstance().getToken().addOnCompleteListener(task -> {
            if (task.isSuccessful() && task.getResult() != null) {
                String token = task.getResult();
                registerTokenWithBackend(token);
            }
        });
        FirebaseMessaging.getInstance().subscribeToTopic("customer_offers");
    }

    private void registerTokenWithBackend(String token) {
        // Automatically inject registered FCM token to webview session or execute registration API
        webView.post(() -> {
            String js = "if (window.fetch) {" +
                    "fetch('/api/device/register-token', {" +
                    "method: 'POST'," +
                    "headers: {'Content-Type': 'application/json'}," +
                    "body: JSON.stringify({token: '" + token + "', app_type: 'customer', platform: 'android'})" +
                    "}).catch(function(e){});" +
                    "}";
            webView.evaluateJavascript(js, null);
        });
    }

    private void showOfflineView() {
        webView.setVisibility(View.GONE);
        layoutOffline.setVisibility(View.VISIBLE);
    }

    private boolean isNetworkAvailable() {
        ConnectivityManager cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
        if (cm == null) return false;
        NetworkInfo info = cm.getActiveNetworkInfo();
        return info != null && info.isConnected();
    }

    public static class MrtumiNativeBridge {
        private final Context context;

        public MrtumiNativeBridge(Context context) {
            this.context = context;
        }

        @JavascriptInterface
        public String getAppVersion() {
            return "1.0.0";
        }

        @JavascriptInterface
        public void showToast(String message) {
            Toast.makeText(context, message, Toast.LENGTH_SHORT).show();
        }

        @JavascriptInterface
        public void shareLink(String title, String url) {
            Intent share = new Intent(Intent.ACTION_SEND);
            share.setType("text/plain");
            share.putExtra(Intent.EXTRA_SUBJECT, title);
            share.putExtra(Intent.EXTRA_TEXT, url);
            context.startActivity(Intent.createChooser(share, "শেয়ার করুন"));
        }
    }
}
