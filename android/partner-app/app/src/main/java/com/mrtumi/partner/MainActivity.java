package com.mrtumi.partner;

import android.annotation.SuppressLint;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.net.ConnectivityManager;
import android.net.NetworkInfo;
import android.net.Uri;
import android.os.Bundle;
import android.view.View;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
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

import com.google.android.material.tabs.TabLayout;
import com.google.firebase.messaging.FirebaseMessaging;

public class MainActivity extends AppCompatActivity {

    public static final String BASE_URL = "https://mrtumi.com";
    private WebView webView;
    private SwipeRefreshLayout swipeRefresh;
    private ProgressBar progressBar;
    private TabLayout tabLayout;
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
        tabLayout = findViewById(R.id.tabLayout);
        layoutOffline = findViewById(R.id.layoutOffline);
        btnRetry = findViewById(R.id.btnRetry);

        setupTabs();
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
                Toast.makeText(this, "ইন্টারনেট সংযোগ পাওয়া যায়নি।", Toast.LENGTH_SHORT).show();
            }
        });

        String initialUrl = BASE_URL + "/vendor";
        if (getIntent() != null && getIntent().hasExtra("target_portal")) {
            String p = getIntent().getStringExtra("target_portal");
            if ("admin".equals(p)) {
                initialUrl = BASE_URL + "/admin";
                if (tabLayout.getTabAt(1) != null) tabLayout.getTabAt(1).select();
            }
        }

        if (isNetworkAvailable()) {
            webView.loadUrl(initialUrl);
        } else {
            showOfflineView();
        }
    }

    private void setupTabs() {
        tabLayout.addTab(tabLayout.newTab().setText("🏪 Vendor Portal"));
        tabLayout.addTab(tabLayout.newTab().setText("🛡️ Admin Portal"));

        tabLayout.addOnTabSelectedListener(new TabLayout.OnTabSelectedListener() {
            @Override
            public void onTabSelected(TabLayout.Tab tab) {
                if (tab.getPosition() == 0) {
                    webView.loadUrl(BASE_URL + "/vendor");
                } else {
                    webView.loadUrl(BASE_URL + "/admin");
                }
            }

            @Override
            public void onTabUnselected(TabLayout.Tab tab) {}

            @Override
            public void onTabReselected(TabLayout.Tab tab) {
                if (tab.getPosition() == 0) {
                    webView.loadUrl(BASE_URL + "/vendor");
                } else {
                    webView.loadUrl(BASE_URL + "/admin");
                }
            }
        });
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void setupWebView() {
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(true);
        settings.setUserAgentString(settings.getUserAgentString() + " MrTumiPartnerApp/1.0.0");

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
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                String scheme = uri.getScheme();
                if ("tel".equals(scheme) || "mailto".equals(scheme)) {
                    startActivity(new Intent(Intent.ACTION_VIEW, uri));
                    return true;
                }
                return false;
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView view, int newProgress) {
                progressBar.setProgress(newProgress);
                progressBar.setVisibility(newProgress == 100 ? View.GONE : View.VISIBLE);
            }

            @Override
            public boolean onShowFileChooser(WebView webView, ValueCallback<Uri[]> filePathCallback, FileChooserParams fileChooserParams) {
                if (fileUploadCallback != null) fileUploadCallback.onReceiveValue(null);
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
                        if (result.getData().getData() != null) {
                            results = new Uri[]{result.getData().getData()};
                        }
                    }
                    fileUploadCallback.onReceiveValue(results);
                    fileUploadCallback = null;
                }
        );
    }

    private void setupSwipeRefresh() {
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
                        Toast.makeText(MainActivity.this, "অ্যাপ থেকে বের হতে আবার চাপুন", Toast.LENGTH_SHORT).show();
                    }
                }
            }
        });
    }

    private void setupPushNotifications() {
        FirebaseMessaging.getInstance().getToken().addOnCompleteListener(task -> {
            if (task.isSuccessful() && task.getResult() != null) {
                String token = task.getResult();
                webView.post(() -> {
                    String js = "if (window.fetch) {" +
                            "fetch('/api/device/register-token', {" +
                            "method: 'POST'," +
                            "headers: {'Content-Type': 'application/json'}," +
                            "body: JSON.stringify({token: '" + token + "', app_type: 'partner', platform: 'android'})" +
                            "}).catch(function(e){});" +
                            "}";
                    webView.evaluateJavascript(js, null);
                });
            }
        });
        FirebaseMessaging.getInstance().subscribeToTopic("partner_orders");
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
}
