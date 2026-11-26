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
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import com.nigafiy.agent.core.Enrollment
import com.nigafiy.agent.core.Mode

/** Enrollment form (or the `nigafiy://enroll` link from Fleet's QR) and the agent's status. */
class MainActivity : Activity() {
    private lateinit var store: Store
    private lateinit var root: LinearLayout
    private lateinit var ui: Ui
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
        ui = Ui(this)
        @Suppress("DEPRECATION")
        run {
            window.statusBarColor = ui.bg
            window.navigationBarColor = ui.bg
            if (!ui.dark) window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR or View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR
        }
        root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(ui.dp(16), ui.dp(16), ui.dp(16), ui.dp(24)) }
        val scroll = ScrollView(this).apply { addView(root); setBackgroundColor(ui.bg); isFillViewport = true }
        if (Build.VERSION.SDK_INT >= 35) {
            // Android 15+ draws an app targeting API 35+ edge to edge: without this the first lines
            // sat under the status bar (first emulator run).
            scroll.setOnApplyWindowInsetsListener { v, insets ->
                val bars = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout() or WindowInsets.Type.ime())
                v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
                insets
            }
        }
        setContentView(scroll)
        fromLink(intent)
        startAgent()
    }

    /**
     * Opening the app runs Nigafiy again after "Stop everything", and resumes an enrollment that was
     * waiting (as BootReceiver does after a reboot or update).
     */
    private fun startAgent() {
        if (store.stopped) {
            store.stopped = false
            android.widget.Toast.makeText(this, R.string.stop_all_resumed, android.widget.Toast.LENGTH_SHORT).show()
        }
        if (store.enrolled || store.pendingEnrollment != null) AgentService.start(this)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        fromLink(intent)
    }

    override fun onResume() {
        super.onResume()
        if (store.stopped) startAgent()
        handler.post(refresh)
    }
    override fun onPause() { super.onPause(); handler.removeCallbacks(refresh) }

    private var prefill: Enrollment? = null
    // Not "error": inside a View's apply { } that name is the view's own TextView.error (first real-phone run).
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

    private fun render() {
        // Keep the scroll position across the 3-second redraws.
        val scroll = root.parent as? ScrollView
        val y = scroll?.scrollY ?: 0
        root.removeAllViews()
        if (store.enrolled) renderStatus() else if (store.pendingEnrollment != null) renderEnrolling() else renderForm()
        val privacy = ui.card(root, getString(R.string.section_privacy))
        privacy.addView(ui.text(getString(R.string.what_is_sent), 13f, ui.muted))
        scroll?.post { scroll.scrollTo(0, y) }
    }

    private fun renderEnrolling() {
        val p = store.pendingEnrollment ?: return
        // If the server refuses the token, the service drops it and the form comes back with these values.
        prefill = p
        root.addView(ui.header(getString(R.string.app_name), getString(R.string.enrolling), ui.warn))
        val c = ui.card(root, getString(R.string.enrolling))
        c.addView(ui.text(getString(R.string.enrolling_to, p.server), 13f, ui.muted, ltr = true))
        store.lastError?.let { ui.note(c, getString(R.string.enroll_failed, it)) }
        // A wrong address or pin retries for ever: let the person go back and fix it.
        ui.addButton(c, getString(R.string.action_change), primary = false) {
            prefill = p
            formError = store.lastError
            store.pendingEnrollment = null
            store.lastError = null
            render()
        }
    }

    private fun renderStatus() {
        val last = store.lastContact
        val fresh = last != 0L && System.currentTimeMillis() - last < 3 * 60_000 && store.lastError == null
        val lastText = if (last == 0L) getString(R.string.status_never) else getString(R.string.status_last, DateUtils.getRelativeTimeSpanString(last))
        val lastValue = if (last == 0L) "—" else DateUtils.getRelativeTimeSpanString(last).toString()
        root.addView(ui.header(getString(R.string.app_name), if (fresh) getString(R.string.header_connected) else lastText, if (fresh) ui.ok else ui.warn))

        val phone = ui.card(root, getString(R.string.enrolled_title))
        val mode = Facts(this, store).mode()
        ui.fact(phone, getString(R.string.label_server), store.server ?: "", ltr = true)
        ui.fact(phone, getString(R.string.label_mode), getString(if (mode == Mode.DEVICE_OWNER) R.string.status_mode_owner else R.string.status_mode_regular))
        ui.fact(phone, getString(R.string.label_last), lastValue)
        ui.fact(phone, getString(R.string.label_endpoint), store.endpointId ?: "", ltr = true)
        store.lastError?.let { ui.note(phone, getString(R.string.status_error, it)) }

        val pm = getSystemService(PowerManager::class.java)
        val needBattery = !pm.isIgnoringBatteryOptimizations(packageName)
        val needNotif = Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        if (needBattery || needNotif) {
            val setup = ui.card(root, getString(R.string.section_setup), getString(R.string.section_setup_hint))
            // The standard settings screens: the person may refuse.
            if (needNotif) ui.addButton(setup, getString(R.string.action_notifications)) { requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1) }
            if (needBattery) ui.addButton(setup, getString(R.string.action_battery)) { startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName"))) }
        }

        // The optional phone controls: each one is the person's own switch in Android's Settings.
        val ctl = ui.card(root, getString(R.string.controls_title), getString(R.string.controls_hint))
        ui.control(ctl, getString(R.string.control_screen), null, getString(R.string.chip_asks), getString(R.string.controls_screen))
        ui.divider(ctl)
        val controlOn = ControlService.isEnabled(this)
        ui.control(
            ctl, getString(R.string.control_remote), controlOn, getString(if (controlOn) R.string.chip_on else R.string.chip_off),
            getString(if (controlOn) R.string.controls_control_on else R.string.controls_control_off),
            getString(if (controlOn) R.string.action_accessibility_off else R.string.action_accessibility),
        ) { startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)) }
        if (!controlOn) {
            // Android 13+ blocks Accessibility for apps installed outside a store until the person
            // allows "restricted settings" in App info (first A36 run of 1.0.2).
            ctl.addView(ui.text(getString(R.string.controls_restricted), 13f, ui.muted, top = 2))
            ui.addButton(ctl, getString(R.string.action_app_info), primary = false) {
                startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName")))
            }
        }
        if (Build.VERSION.SDK_INT >= 30) {
            ui.divider(ctl)
            val filesOn = android.os.Environment.isExternalStorageManager()
            ui.control(
                ctl, getString(R.string.control_files), filesOn, getString(if (filesOn) R.string.chip_allowed else R.string.chip_not_allowed),
                getString(if (filesOn) R.string.controls_files_on else R.string.controls_files_off),
                getString(if (filesOn) R.string.action_files_off else R.string.action_files),
            ) {
                try {
                    startActivity(Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, Uri.parse("package:$packageName")))
                } catch (_: Exception) {
                    startActivity(Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION))
                }
            }
        }
        ui.divider(ctl)
        ui.control(ctl, getString(R.string.control_ring_message), null, getString(R.string.chip_notification), getString(R.string.controls_ring_message))

        // The person's own off switch. Not on a company phone (Device Owner): IT manages that one.
        if (mode != Mode.DEVICE_OWNER) {
            val stop = ui.card(root, getString(R.string.stop_all_title), getString(R.string.stop_all_hint))
            ui.addButton(stop, getString(R.string.action_stop_all)) { confirmStopAll() }
        }
    }

    private fun confirmStopAll() {
        android.app.AlertDialog.Builder(this)
            .setTitle(R.string.stop_all_confirm_title)
            .setMessage(R.string.stop_all_confirm_text)
            .setPositiveButton(R.string.action_stop_all) { _, _ ->
                AgentService.stopEverything(this)
                handler.removeCallbacks(refresh)
                finishAndRemoveTask()
            }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
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
        ui.styleField(this)
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
        root.addView(ui.header(getString(R.string.app_name), getString(R.string.header_not_enrolled), null))
        val quick = ui.card(root, getString(R.string.title_enroll), getString(R.string.enroll_hint))
        ui.addButton(quick, getString(R.string.action_scan)) { scanQr() }
        ui.addButton(quick, getString(R.string.action_paste), primary = false) { pasteEnrollment() }

        val manual = ui.card(root, getString(R.string.section_manual))
        val server = field(R.string.field_server, draftServer, uri = true) { draftServer = it }
        val token = field(R.string.field_token, draftToken, uri = false) { draftToken = it }
        val pin = field(R.string.field_pin, draftPin, uri = false) { draftPin = it }
        manual.addView(server); manual.addView(token); manual.addView(pin)
        formError?.let { ui.note(manual, getString(R.string.enroll_failed, it)) }
        ui.addButton(manual, getString(R.string.action_enroll)) {
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
    }
}
