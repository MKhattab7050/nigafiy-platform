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
    private val refresh = object : Runnable {
        override fun run() { render(); handler.postDelayed(this, 3000) }
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
    private var error: String? = null

    private fun fromLink(intent: Intent?) {
        val data = intent?.data ?: return
        if (store.enrolled) return
        try {
            prefill = Enrollment.fromLink(data.toString())
            error = null
        } catch (e: IllegalArgumentException) {
            error = e.message
        }
    }

    private fun text(s: String, size: Float = 16f) = TextView(this).apply { text = s; textSize = size; setPadding(0, 12, 0, 12) }

    private fun render() {
        root.removeAllViews()
        if (store.enrolled) renderStatus() else if (store.pendingEnrollment != null) renderEnrolling() else renderForm()
        root.addView(text(getString(R.string.what_is_sent), 13f))
    }

    private fun renderEnrolling() {
        root.addView(text(getString(R.string.enrolling), 20f))
        store.lastError?.let { root.addView(text(getString(R.string.enroll_failed, it))) }
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

    private fun renderForm() {
        handler.removeCallbacks(refresh)
        root.addView(text(getString(R.string.title_enroll), 20f))
        root.addView(text(getString(R.string.enroll_hint)))
        val server = EditText(this).apply { hint = getString(R.string.field_server); inputType = InputType.TYPE_TEXT_VARIATION_URI; setText(prefill?.server ?: ""); textDirection = View.TEXT_DIRECTION_LTR }
        val token = EditText(this).apply { hint = getString(R.string.field_token); setText(prefill?.token ?: ""); textDirection = View.TEXT_DIRECTION_LTR }
        val pin = EditText(this).apply { hint = getString(R.string.field_pin); setText(prefill?.pin ?: ""); textDirection = View.TEXT_DIRECTION_LTR }
        root.addView(server); root.addView(token); root.addView(pin)
        error?.let { root.addView(text(getString(R.string.enroll_failed, it))) }
        root.addView(Button(this).apply {
            text = getString(R.string.action_enroll)
            setOnClickListener {
                try {
                    store.pendingEnrollment = Enrollment.of(server.text.toString(), token.text.toString(), pin.text.toString())
                    store.lastError = null
                    error = null
                    AgentService.start(this@MainActivity)
                    handler.post(refresh)
                } catch (e: IllegalArgumentException) {
                    error = e.message
                    render()
                }
            }
        })
    }
}
