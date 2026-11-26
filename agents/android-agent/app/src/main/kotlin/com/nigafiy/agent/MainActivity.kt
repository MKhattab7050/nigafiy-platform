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
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import com.nigafiy.agent.core.Enrollment
import com.nigafiy.agent.core.Mode

/**
 * Three tabs: Home (the enrollment form, or the agent's status, and "Your connection"), Tools (the
 * phone's own network tools, ToolsScreen) and Settings (phone controls, Stop everything, Log out,
 * privacy).
 */
class MainActivity : Activity() {
    private lateinit var store: Store
    private lateinit var root: LinearLayout
    private lateinit var ui: Ui
    private lateinit var scroll: ScrollView
    private lateinit var toolsScroll: ScrollView
    private lateinit var navHolder: FrameLayout
    private lateinit var tools: ToolsScreen
    private var tab = TAB_HOME
    private var lastCheck: NetProbe.CheckResult? = null
    private val handler = Handler(Looper.getMainLooper())
    // Redraws Home and Settings every 3 s (never Tools, which updates itself). Never the form either:
    // redrawing it threw away what the person was typing (first real-phone run).
    private val refresh = object : Runnable {
        override fun run() {
            if (tab != TAB_TOOLS) render()
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
        scroll = ScrollView(this).apply { addView(root); isFillViewport = true }
        tools = ToolsScreen(this, ui) { r -> lastCheck = r }
        toolsScroll = ScrollView(this).apply { addView(tools.view); isFillViewport = true; visibility = View.GONE }
        val content = FrameLayout(this).apply { addView(scroll); addView(toolsScroll) }
        navHolder = FrameLayout(this)
        val outer = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(ui.bg)
            addView(content, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f))
            addView(navHolder, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))
        }
        if (Build.VERSION.SDK_INT >= 35) {
            // Android 15+ draws an app targeting API 35+ edge to edge: without this the first lines
            // sat under the status bar (first emulator run).
            outer.setOnApplyWindowInsetsListener { v, insets ->
                val bars = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout() or WindowInsets.Type.ime())
                v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
                insets
            }
        }
        setContentView(outer)
        tab = savedInstanceState?.getInt("tab", TAB_HOME) ?: TAB_HOME
        fromLink(intent)
        startAgent()
        showTab(tab)
    }

    private fun showTab(t: Int) {
        if (tab == TAB_TOOLS && t != TAB_TOOLS) tools.onHide()
        tab = t
        scroll.visibility = if (t == TAB_TOOLS) View.GONE else View.VISIBLE
        toolsScroll.visibility = if (t == TAB_TOOLS) View.VISIBLE else View.GONE
        navHolder.removeAllViews()
        navHolder.addView(ui.tabBar(listOf(
            Triple(getString(R.string.tab_home), R.drawable.ic_tab_home) { showTab(TAB_HOME) },
            Triple(getString(R.string.tab_tools), R.drawable.ic_tab_tools) { showTab(TAB_TOOLS) },
            Triple(getString(R.string.tab_settings), R.drawable.ic_tab_settings) { showTab(TAB_SETTINGS) },
        ), t))
        if (t == TAB_TOOLS) tools.onShow() else { render(); scroll.scrollTo(0, 0) }
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
    override fun onPause() { super.onPause(); handler.removeCallbacks(refresh); if (tab == TAB_TOOLS) tools.onHide() }

    override fun onPostResume() { super.onPostResume(); if (tab == TAB_TOOLS) tools.onShow() }

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
        val y = scroll.scrollY
        root.removeAllViews()
        if (tab == TAB_SETTINGS) {
            renderSettings()
        } else {
            if (store.enrolled) renderStatus() else if (store.pendingEnrollment != null) renderEnrolling() else renderForm()
            renderConnection()
        }
        scroll.post { scroll.scrollTo(0, y) }
    }

    /** Home: "Your connection" — the Wi-Fi signal now and the last check, with a button to run one. */
    private fun renderConnection() {
        val c = ui.card(root, getString(R.string.conn_title))
        val r = lastCheck
        if (r != null) {
            val (title, detail) = tools.verdictText(r.verdict)
            c.addView(ui.verdict(title, detail, if (r.verdict == com.nigafiy.agent.core.NetTools.Verdict.ALL_GOOD) ui.ok else ui.warn))
        }
        val l = try { NetProbe(this).link() } catch (_: Exception) { null }
        if (l != null) {
            when {
                l.onWifi && l.rssi != null -> ui.fact(c, getString(R.string.wifi_signal), tools.signalLine(l.rssi))
                !l.connected -> ui.fact(c, getString(R.string.wifi_title), getString(R.string.wifi_off))
                !l.onWifi -> ui.fact(c, getString(R.string.wifi_title), getString(R.string.wifi_off_cell))
            }
        }
        ui.addButton(c, getString(R.string.check_run)) { showTab(TAB_TOOLS); tools.runCheck() }
        ui.addButton(c, getString(R.string.conn_more_tools), primary = false) { showTab(TAB_TOOLS) }
    }

    /** Settings: the phone controls, Stop everything and Log out (managed phones), and privacy. */
    private fun renderSettings() {
        root.addView(ui.header(getString(R.string.tab_settings), getString(R.string.settings_subtitle), null))
        if (store.enrolled) renderControls()
        val privacy = ui.card(root, getString(R.string.section_privacy))
        privacy.addView(ui.text(getString(R.string.what_is_sent), 13f, ui.muted))
        privacy.addView(ui.text(getString(R.string.tools_privacy), 13f, ui.muted))
        root.addView(ui.text(getString(R.string.app_version, com.nigafiy.agent.core.Version.NAME), 12f, ui.muted, top = 4).apply { gravity = android.view.Gravity.CENTER })
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
    }

    private fun renderControls() {
        val mode = Facts(this, store).mode()
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

        // The person's own off switch and log out. Not on a company phone (Device Owner): IT manages that one.
        if (mode != Mode.DEVICE_OWNER) {
            val stop = ui.card(root, getString(R.string.stop_all_title), getString(R.string.stop_all_hint))
            ui.addButton(stop, getString(R.string.action_stop_all)) { confirmStopAll() }
            val out = ui.card(root, getString(R.string.logout_title), getString(R.string.logout_hint))
            ui.addButton(out, getString(R.string.action_logout), primary = false) { confirmLogOut() }
        }
    }

    private fun confirmLogOut() {
        android.app.AlertDialog.Builder(this)
            .setTitle(R.string.logout_confirm_title)
            .setMessage(R.string.logout_confirm_text)
            .setPositiveButton(R.string.action_logout) { _, _ -> logOut() }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
    }

    /**
     * Log out: the server revokes this phone (POST /agent/leave), then everything stops and the app
     * forgets its server and credential. Without the server (offline, older version) the phone still
     * logs out, and says that Nigafiy keeps listing it until it is removed there.
     */
    private fun logOut() {
        val server = store.server ?: return
        val pin = store.pin
        val cred = store.credential
        Thread {
            val told = try { com.nigafiy.agent.core.Gateway(server, pin, cred).leave(); true } catch (_: Exception) { false }
            runOnUiThread {
                try { ScreenShare.stopEverything(this) } catch (_: Exception) { }
                stopService(Intent(this, AgentService::class.java))
                getSystemService(android.app.NotificationManager::class.java).cancelAll()
                store.forget()
                android.widget.Toast.makeText(this, if (told) R.string.logout_done else R.string.logout_done_offline, android.widget.Toast.LENGTH_LONG).show()
                showTab(TAB_HOME)
            }
        }.start()
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
        outState.putInt("tab", tab)
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

    private companion object {
        const val TAB_HOME = 0
        const val TAB_TOOLS = 1
        const val TAB_SETTINGS = 2
    }
}
