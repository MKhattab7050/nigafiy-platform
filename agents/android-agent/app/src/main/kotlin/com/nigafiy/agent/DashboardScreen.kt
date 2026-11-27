package com.nigafiy.agent

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.net.http.SslCertificate
import android.net.http.SslError
import android.view.View
import android.content.ContentValues
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.util.Base64
import android.view.ViewGroup
import android.view.WindowInsets
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.widget.Toast
import java.io.File
import android.webkit.SslErrorHandler
import android.webkit.WebResourceError
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
    /** The address the session was made at: the home one, or the Tailscale one away from home. */
    private var sessionServer: String? = null
    private var loading = false
    private var pendingPath: String? = null
    private var fullView: View? = null
    private var fullDone: WebChromeClient.CustomViewCallback? = null
    private var filePick: ValueCallback<Array<Uri>>? = null
    /** After a move to another address of the server: forget the old address's pages once the new one loads. */
    private var clearHistoryNext = false
    /** When the dashboard last moved; a new address that does not answer yet is tried again after FOLLOW_RETRY_MS. */
    private var followAt = 0L
    private val watch = object : Runnable {
        override fun run() {
            followServer()
            view.postDelayed(this, WATCH_MS)
        }
    }

    init {
        view.addView(status, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT))
    }

    /** Shows the dashboard, at [path] when given (an alert's page). */
    fun open(path: String? = null) {
        val server = store.currentServer ?: return
        val w = web
        // Away from home the phone talks to another address of the same server: a new session there.
        val fresh = System.currentTimeMillis() - sessionAt < SESSION_REUSE_MS && sessionServer == server
        if (w != null && fresh) {
            if (path != null) w.loadUrl(server + path)
            return
        }
        startSession(path)
    }

    /**
     * The phone left home (or came back) while the dashboard was open: the agent now talks to another
     * address of the same server, and the open page still points at the old one, which no longer
     * answers (first away-from-home run on the A36, 2026-11-27). Make a session at the new address
     * and reopen the same page there.
     */
    private fun followServer() {
        val w = web ?: return
        val old = sessionServer ?: return
        if (loading || !view.isShown) return
        val now = store.currentServer ?: return
        if (now == old) return
        val t = System.currentTimeMillis()
        if (t - followAt < FOLLOW_RETRY_MS) return
        followAt = t
        val o = Uri.parse(old)
        val path = w.url?.let { Uri.parse(it) }
            ?.takeIf { it.scheme == o.scheme && it.host == o.host && it.port == o.port }
            ?.let { (it.encodedPath ?: "/") + (it.encodedQuery?.let { q -> "?$q" } ?: "") }
            ?: "/"
        if (fullView != null) { fullDone?.onCustomViewHidden(); hideFull() }
        w.stopLoading()
        sessionAt = 0
        clearHistoryNext = true
        startSession(path)
    }

    /** Back inside the dashboard first; false when there is nothing to go back to. */
    fun back(): Boolean {
        if (fullView != null) { fullDone?.onCustomViewHidden(); hideFull(); return true }
        val w = web ?: return false
        if (!w.canGoBack()) return false
        w.goBack()
        return true
    }

    private fun startSession(path: String?) {
        // A page asked for while the session is still starting (an alert tapped with the app closed)
        // is opened once it is ready.
        if (path != null) pendingPath = path
        if (loading) return
        val server = store.currentServer ?: return
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
                sessionServer = server
                val cm = CookieManager.getInstance()
                cm.setAcceptCookie(true)
                cm.setCookie(server, "ld_session=$value; Path=/; Secure; HttpOnly; SameSite=Lax")
                cm.flush()
                val w = web ?: makeWebView().also { web = it }
                status.visibility = View.GONE
                w.visibility = View.VISIBLE
                w.loadUrl(server + (pendingPath ?: "/"))
                pendingPath = null
            }
        }.start()
    }

    /** The answer of the file picker an upload opened (MainActivity.onActivityResult). */
    fun onFilePicked(resultCode: Int, data: Intent?) {
        filePick?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data))
        filePick = null
    }

    // Full screen (the remote desktop's full-screen button): the page's element covers the whole
    // screen, system bars hidden, until Back or the page leaves full screen.
    private fun showFull(v: View, done: WebChromeClient.CustomViewCallback) {
        if (fullView != null) { done.onCustomViewHidden(); return }
        fullView = v
        fullDone = done
        (act.window.decorView as ViewGroup).addView(v, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        if (Build.VERSION.SDK_INT >= 30) act.window.insetsController?.hide(WindowInsets.Type.systemBars())
        // A computer's screen is wide: full screen turns the phone sideways.
        act.requestedOrientation = android.content.pm.ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
    }

    private fun hideFull() {
        val v = fullView ?: return
        (act.window.decorView as ViewGroup).removeView(v)
        fullView = null
        fullDone = null
        if (Build.VERSION.SDK_INT >= 30) act.window.insetsController?.show(WindowInsets.Type.systemBars())
        act.requestedOrientation = android.content.pm.ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
    }

    /** Files the dashboard hands over (downloads from a computer, reports): saved to Downloads. */
    private inner class Files {
        @JavascriptInterface
        fun save(name: String, dataUrl: String) {
            val safe = name.replace(Regex("[\\\\/:*?\"<>|\\u0000-\\u001f]"), "_").trim().ifEmpty { "download" }.take(120)
            val ok = try {
                val bytes = Base64.decode(dataUrl.substringAfter(','), Base64.DEFAULT)
                if (Build.VERSION.SDK_INT >= 29) {
                    val values = ContentValues().apply { put(MediaStore.Downloads.DISPLAY_NAME, safe) }
                    val uri = act.contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: throw IllegalStateException("no uri")
                    act.contentResolver.openOutputStream(uri)!!.use { it.write(bytes) }
                } else {
                    val dir = act.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS) ?: throw IllegalStateException("no folder")
                    File(dir, safe).writeBytes(bytes)
                }
                true
            } catch (_: Exception) { false }
            act.runOnUiThread { Toast.makeText(act, act.getString(if (ok) R.string.dashboard_saved else R.string.dashboard_save_failed, safe), Toast.LENGTH_LONG).show() }
        }
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
        addJavascriptInterface(Files(), "NigafiyFiles")
        // Without a WebChromeClient the page's confirm()/alert() do nothing, and full screen and
        // file pickers never open.
        webChromeClient = object : WebChromeClient() {
            override fun onShowCustomView(v: View, done: CustomViewCallback) = showFull(v, done)
            override fun onHideCustomView() = hideFull()
            override fun onShowFileChooser(view: WebView, cb: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                filePick?.onReceiveValue(null)
                filePick = cb
                return try {
                    @Suppress("DEPRECATION")
                    act.startActivityForResult(params.createIntent(), REQ_FILE)
                    true
                } catch (_: Exception) { filePick = null; false }
            }
        }
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

            override fun onPageFinished(view: WebView, url: String) {
                if (!sameServer(Uri.parse(url))) return
                view.evaluateJavascript(SAVE_BLOBS, null)
                // Back must not walk into the old address's pages, which do not answer any more.
                if (clearHistoryNext) { clearHistoryNext = false; view.clearHistory() }
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                // A page of the old address failed: move now rather than at the next check.
                if (request.isForMainFrame) followServer()
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
        this@DashboardScreen.view.postDelayed(watch, WATCH_MS)
    }

    private fun sameServer(u: Uri): Boolean {
        val s = Uri.parse(sessionServer ?: store.currentServer ?: return false)
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

    companion object {
        const val REQ_FILE = 4711

        // The dashboard saves files through blob: links (<a download>), which a WebView cannot
        // download: hand them to NigafiyFiles instead. Up to 200 MB. The page's CSP does not allow
        // fetch() of a blob: URL, so the Blob is kept when the page makes its URL.
        private const val SAVE_BLOBS = """(function(){if(window.__nfy)return;window.__nfy=1;
var blobs=new Map(),mk=URL.createObjectURL,rv=URL.revokeObjectURL;
URL.createObjectURL=function(b){var u=mk.call(URL,b);if(b instanceof Blob)blobs.set(u,b);return u};
URL.revokeObjectURL=function(u){setTimeout(function(){blobs.delete(u)},60000);return rv.call(URL,u)};
function grab(a){if(!a||!a.href||a.href.indexOf('blob:')!==0)return false;var b=blobs.get(a.href);if(!b)return false;var n=a.getAttribute('download')||'download';
if(b.size>209715200){alert('Too big for the phone: '+n);return true}
var f=new FileReader();f.onload=function(){NigafiyFiles.save(n,f.result)};f.readAsDataURL(b);return true}
document.addEventListener('click',function(e){var a=e.target&&e.target.closest&&e.target.closest('a[download]');if(grab(a))e.preventDefault()},true);
var c=HTMLAnchorElement.prototype.click;HTMLAnchorElement.prototype.click=function(){if(this.hasAttribute('download')&&grab(this))return;return c.call(this)}})()"""

        // A dashboard session lasts the server's session lifetime; ask again after a few hours anyway.
        const val SESSION_REUSE_MS = 4 * 3600_000L

        /** How often an open dashboard checks whether the agent moved to another server address. */
        const val WATCH_MS = 5_000L
        const val FOLLOW_RETRY_MS = 30_000L
    }
}
