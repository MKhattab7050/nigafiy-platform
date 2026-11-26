package com.nigafiy.agent

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.net.http.SslCertificate
import android.net.http.SslError
import android.view.View
import android.webkit.CookieManager
import android.webkit.SslErrorHandler
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import com.nigafiy.agent.core.Gateway
import com.nigafiy.agent.core.Pin

/**
 * The Nigafiy dashboard inside the app, for admin phones (docs/roadmap/2026-11-26-admin-phones.md):
 * Fleet, the computers, the network, with the permissions of the admin who made this phone an admin
 * phone. The server gives the phone a dashboard session over its pinned connection; the WebView
 * accepts only that same server certificate (it cannot use the pin itself) and opens every other
 * address in the browser.
 */
class DashboardScreen(private val act: Activity, private val ui: Ui, private val store: Store) {
    val view = FrameLayout(act)
    private val status: TextView = ui.text("", 14f, ui.muted).apply { setPadding(ui.dp(24), ui.dp(24), ui.dp(24), ui.dp(24)) }
    private var web: WebView? = null
    private var leafSha256: String? = null
    private var sessionAt = 0L
    private var loading = false

    init {
        view.addView(status, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT))
    }

    /** Shows the dashboard, at [path] when given (an alert's page). */
    fun open(path: String? = null) {
        val server = store.server ?: return
        val w = web
        val fresh = System.currentTimeMillis() - sessionAt < SESSION_REUSE_MS
        if (w != null && fresh) {
            if (path != null) w.loadUrl(server + path)
            return
        }
        startSession(path)
    }

    /** Back inside the dashboard first; false when there is nothing to go back to. */
    fun back(): Boolean {
        val w = web ?: return false
        if (!w.canGoBack()) return false
        w.goBack()
        return true
    }

    private fun startSession(path: String?) {
        if (loading) return
        val server = store.server ?: return
        loading = true
        say(act.getString(R.string.dashboard_loading))
        val pin = store.pin
        val cred = store.credential
        Thread {
            val result = try {
                val g = Gateway(server, pin, cred)
                val r = g.dashboardSession()
                Triple(r["value"] as? String, g.lastLeafSha256, null)
            } catch (e: com.nigafiy.agent.core.GatewayError) {
                Triple(null, null, if (e.code == "not_admin_phone") act.getString(R.string.dashboard_not_admin) else act.getString(R.string.dashboard_error, e.message))
            } catch (e: Exception) {
                Triple(null, null, act.getString(R.string.dashboard_error, e.message ?: e.javaClass.simpleName))
            }
            act.runOnUiThread {
                loading = false
                val (value, leaf, error) = result
                if (value == null) { say(error ?: act.getString(R.string.dashboard_error, "")); return@runOnUiThread }
                leafSha256 = leaf
                sessionAt = System.currentTimeMillis()
                val cm = CookieManager.getInstance()
                cm.setAcceptCookie(true)
                cm.setCookie(server, "ld_session=$value; Path=/; Secure; HttpOnly; SameSite=Lax")
                cm.flush()
                val w = web ?: makeWebView().also { web = it }
                status.visibility = View.GONE
                w.visibility = View.VISIBLE
                w.loadUrl(server + (path ?: "/"))
            }
        }.start()
    }

    private fun say(text: String) {
        status.text = text
        status.visibility = View.VISIBLE
        web?.visibility = View.GONE
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun makeWebView(): WebView = WebView(act).apply {
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.allowFileAccess = false
        settings.allowContentAccess = false
        settings.mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW
        setBackgroundColor(ui.bg)
        webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url
                if (sameServer(url)) return false
                // Anything else (help pages, downloads elsewhere) opens in the phone's browser.
                try { act.startActivity(Intent(Intent.ACTION_VIEW, url)) } catch (_: Exception) { }
                return true
            }

            override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
                // The session ended (revoked, made a regular phone, or expired): get a new one once.
                val p = Uri.parse(url).path ?: ""
                if (sameServer(Uri.parse(url)) && (p == "/login" || p.startsWith("/login/")) && System.currentTimeMillis() - sessionAt > 10_000) {
                    view.stopLoading()
                    sessionAt = 0
                    startSession("/")
                }
            }

            @SuppressLint("WebViewClientOnReceivedSslError")
            override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
                // Nigafiy's LAN certificate comes from its own CA, which Android does not know. Accept it
                // only when it is exactly the certificate the pinned connection just verified.
                val want = leafSha256
                val der = try { SslCertificate.saveState(error.certificate).getByteArray("x509-certificate") } catch (_: Exception) { null }
                if (want != null && der != null && sameServer(Uri.parse(error.url)) && Pin.sha256Hex(der) == want) handler.proceed() else handler.cancel()
            }
        }
        this@DashboardScreen.view.addView(this, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
    }

    private fun sameServer(u: Uri): Boolean {
        val s = Uri.parse(store.server ?: return false)
        return u.scheme == s.scheme && u.host == s.host && u.port == s.port
    }

    /** Home tab: the last network alerts, newest first; a tap opens that page here. */
    fun alertsCard(root: LinearLayout, onOpen: (String) -> Unit) {
        val card = ui.card(root, act.getString(R.string.home_alerts_title))
        val list = Alerts.recent(store)
        if (list.isEmpty()) {
            card.addView(ui.text(act.getString(R.string.home_alerts_none), 14f, ui.muted))
            return
        }
        for (a in list.take(5)) {
            val title = if (a.resolved) act.getString(R.string.alert_resolved, a.title) else a.title
            ui.deviceRow(card, title, a.body.lineSequence().firstOrNull() ?: "", null, null)
            (card.getChildAt(card.childCount - 2) as? View)?.apply { isClickable = true; setOnClickListener { onOpen(a.path) } }
        }
    }

    private companion object {
        // A dashboard session lasts the server's session lifetime; ask again after a few hours anyway.
        const val SESSION_REUSE_MS = 4 * 3600_000L
    }
}
