package com.nigafiy.agent

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import android.text.InputType
import android.text.format.DateUtils
import android.view.View
import android.view.WindowInsets
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import com.nigafiy.agent.core.Enrollment
import com.nigafiy.agent.core.Mode

/** Enrollment form (or the `nigafiy://enroll` link from Fleet's QR) and the agent's status. */
class MainActivity : Activity() {
    private lateinit var store: Store
    private lateinit var root: LinearLayout
    private val handler = Handler(Looper.getMainLooper())
    // Redraws the status / enrolling screens every 3 s. Never the form: redrawing it threw away what
    // the person was typing (first real-phone run: "I type them and it erases them").
    private val refresh = object : Runnable {
        override fun run() {
            render()
            if (store.enrolled || store.pendingEnrollment != null) handler.postDelayed(this, 3000)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        store = Store(this)
        root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(48, 48, 48, 48) }
        val scroll = ScrollView(this).apply { addView(root) }
        if (Build.VERSION.SDK_INT >= 35) {
            // Android 15+ draws an app targeting API 35+ edge to edge: without this the first lines
            // (title, enrollment error) sat under the status and action bars (first emulator run).
            // The top inset Android hands the content already includes the action bar.
            scroll.setOnApplyWindowInsetsListener { v, insets ->
                val bars = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout() or WindowInsets.Type.ime())
                v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
                insets
            }
        }
        setContentView(scroll)
        fromLink(intent)
        // Also resumes an enrollment that was waiting (as BootReceiver does after a reboot or update).
        if (store.enrolled || store.pendingEnrollment != null) AgentService.start(this)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        fromLink(intent)
    }

    override fun onResume() { super.onResume(); handler.post(refresh) }
    override fun onPause() { super.onPause(); handler.removeCallbacks(refresh) }

    private var prefill: Enrollment? = null
    // Not "error": inside Button(this).apply { } that name is the button's own TextView.error, so the
    // message went onto the button and the form never showed it (first real-phone run).
    private var formError: String? = null

    private fun fromLink(intent: Intent?) {
        val data = intent?.data ?: return
        if (store.enrolled) return
        try {
            prefill = Enrollment.fromLink(data.toString())
            formError = null
        } catch (e: IllegalArgumentException) {
            formError = e.message
        }
    }

    private fun text(s: String, size: Float = 16f) = TextView(this).apply { text = s; textSize = size; setPadding(0, 12, 0, 12) }

    private fun render() {
        root.removeAllViews()
        if (store.enrolled) renderStatus() else if (store.pendingEnrollment != null) renderEnrolling() else renderForm()
        root.addView(text(getString(R.string.what_is_sent), 13f))
    }

    private fun renderEnrolling() {
        val p = store.pendingEnrollment ?: return
        // If the server refuses the token, the service drops it and the form comes back with these values.
        prefill = p
        root.addView(text(getString(R.string.enrolling), 20f))
        root.addView(text(getString(R.string.enrolling_to, p.server), 13f).apply { textDirection = View.TEXT_DIRECTION_LTR })
        store.lastError?.let { root.addView(text(getString(R.string.enroll_failed, it))) }
        root.addView(Button(this).apply {
            text = getString(R.string.action_change)
            // A wrong address or pin retries for ever: let the person go back and fix it.
            setOnClickListener {
                prefill = p
                formError = store.lastError
                store.pendingEnrollment = null
                store.lastError = null
                render()
            }
        })
    }

    private fun renderStatus() {
        root.addView(text(getString(R.string.enrolled_title), 20f))
        root.addView(text(getString(R.string.status_server, store.server)))
        root.addView(text(getString(R.string.status_endpoint, store.endpointId ?: "")))
        val mode = Facts(this, store).mode()
        root.addView(text(getString(if (mode == Mode.DEVICE_OWNER) R.string.status_mode_owner else R.string.status_mode_regular)))
        val last = store.lastContact
        root.addView(text(if (last == 0L) getString(R.string.status_never) else getString(R.string.status_last, DateUtils.getRelativeTimeSpanString(last))))
        store.lastError?.let { root.addView(text(getString(R.string.status_error, it))) }
        val pm = getSystemService(PowerManager::class.java)
        if (!pm.isIgnoringBatteryOptimizations(packageName)) {
            root.addView(Button(this).apply {
                text = getString(R.string.action_battery)
                // The standard settings screen: the person may refuse.
                setOnClickListener { startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName"))) }
            })
        }
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            root.addView(Button(this).apply {
                text = getString(R.string.action_notifications)
                setOnClickListener { requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1) }
            })
        }
    }

    // What was typed, kept across redraws (an error, a refused token, rotation) so nothing is lost.
    private var draftServer: String? = null
    private var draftToken: String? = null
    private var draftPin: String? = null

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        outState.putString("server", draftServer); outState.putString("token", draftToken); outState.putString("pin", draftPin)
    }

    override fun onRestoreInstanceState(state: Bundle) {
        super.onRestoreInstanceState(state)
        draftServer = state.getString("server"); draftToken = state.getString("token"); draftPin = state.getString("pin")
        render()
    }

    /** One field: left-to-right, no auto-correct or auto-capitals (they change the token's letters). */
    private fun field(hintRes: Int, value: String?, uri: Boolean, onChange: (String) -> Unit) = EditText(this).apply {
        hint = getString(hintRes)
        inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS or
            (if (uri) InputType.TYPE_TEXT_VARIATION_URI else InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD)
        isSingleLine = true
        textDirection = View.TEXT_DIRECTION_LTR
        textAlignment = View.TEXT_ALIGNMENT_VIEW_START
        setText(value ?: "")
        addTextChangedListener(object : android.text.TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) = Unit
            override fun onTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) = Unit
            override fun afterTextChanged(s: android.text.Editable?) = onChange(s?.toString().orEmpty())
        })
    }

    /** Google's code scanner: its own camera screen, no camera permission for this app. */
    private fun scanQr() {
        try {
            val options = com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions.Builder()
                .setBarcodeFormats(com.google.mlkit.vision.barcode.common.Barcode.FORMAT_QR_CODE)
                .build()
            com.google.mlkit.vision.codescanner.GmsBarcodeScanning.getClient(this, options).startScan()
                .addOnSuccessListener { useEnrollmentText(it.rawValue) }
                .addOnFailureListener { e -> formError = getString(R.string.scan_unavailable, e.message ?: e.javaClass.simpleName); render() }
        } catch (e: Exception) {
            formError = getString(R.string.scan_unavailable, e.message ?: e.javaClass.simpleName)
            render()
        }
    }

    private fun pasteEnrollment() {
        val clip = getSystemService(android.content.ClipboardManager::class.java)?.primaryClip
        val pasted = if (clip != null && clip.itemCount > 0) clip.getItemAt(0).coerceToText(this)?.toString() else null
        if (pasted.isNullOrBlank()) { formError = getString(R.string.paste_empty); render(); return }
        useEnrollmentText(pasted)
    }

    /** A scanned or pasted `nigafiy://enroll?…` link fills all three fields; a bare ldea_ token fills the token. */
    private fun useEnrollmentText(raw: String?) {
        val v = raw?.trim().orEmpty()
        val token = Regex("ldea_[A-Za-z0-9_-]{20,200}").find(v)?.value
        when {
            v.startsWith("nigafiy://", ignoreCase = true) -> try {
                prefill = Enrollment.fromLink(v)
                formError = null
                store.lastError = null
            } catch (e: IllegalArgumentException) {
                formError = e.message
            }
            token != null -> { draftToken = token; formError = null; store.lastError = null }
            else -> formError = getString(R.string.scan_not_ours)
        }
        render()
    }

    private fun renderForm() {
        handler.removeCallbacks(refresh)
        // A link or a refused enrollment brings values: they replace the draft once.
        prefill?.let { draftServer = it.server; draftToken = it.token; draftPin = it.pin; prefill = null }
        // The service drops a token the server refused (401) and records why: say so here.
        if (formError == null) formError = store.lastError
        root.addView(text(getString(R.string.title_enroll), 20f))
        root.addView(text(getString(R.string.enroll_hint)))
        root.addView(Button(this).apply { text = getString(R.string.action_scan); setOnClickListener { scanQr() } })
        root.addView(Button(this).apply { text = getString(R.string.action_paste); setOnClickListener { pasteEnrollment() } })
        val server = field(R.string.field_server, draftServer, uri = true) { draftServer = it }
        val token = field(R.string.field_token, draftToken, uri = false) { draftToken = it }
        val pin = field(R.string.field_pin, draftPin, uri = false) { draftPin = it }
        root.addView(server); root.addView(token); root.addView(pin)
        formError?.let { root.addView(text(getString(R.string.enroll_failed, it))) }
        root.addView(Button(this).apply {
            text = getString(R.string.action_enroll)
            setOnClickListener {
                try {
                    store.pendingEnrollment = Enrollment.of(server.text.toString(), token.text.toString(), pin.text.toString())
                    store.lastError = null
                    formError = null
                    AgentService.start(this@MainActivity)
                    handler.removeCallbacks(refresh)
                    handler.post(refresh)
                } catch (e: IllegalArgumentException) {
                    formError = e.message
                    render()
                }
            }
        })
    }
}
