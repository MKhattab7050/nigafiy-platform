package com.nigafiy.agent

import android.app.Activity
import android.content.Intent
import android.media.projection.MediaProjectionConfig
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Bundle
import android.graphics.Typeface
import android.view.Gravity
import android.view.View
import android.view.WindowInsets
import android.widget.LinearLayout
import android.widget.ScrollView
import java.lang.ref.WeakReference

/**
 * "IT asks to see your screen": who, why, what they will be able to do, and two buttons. Share
 * opens Android's own screen-capture dialog (MediaProjection), which the person must accept too;
 * Refuse, Back or closing Android's dialog refuses. Opened from the request notification.
 */
class ShareRequestActivity : Activity() {
    private var sessionId: String? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        sessionId = intent.getStringExtra(ScreenShare.EXTRA_SESSION)
        val p = ScreenShare.pending
        if (p == null || p.request.sessionId != sessionId) {
            // Answered, cancelled or timed out meanwhile.
            finish()
            return
        }
        current = WeakReference(this)
        val req = p.request
        val ui = Ui(this)
        @Suppress("DEPRECATION")
        run {
            window.statusBarColor = ui.bg
            window.navigationBarColor = ui.bg
            if (!ui.dark) window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR or View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR
        }
        val canControl = req.control && ControlService.isEnabled(this)

        // Scrolling part: header, who/why, what happens.
        val body = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(ui.dp(16), ui.dp(16), ui.dp(16), ui.dp(8)) }
        body.addView(ui.header(getString(R.string.share_request_title), getString(R.string.share_request_sub), null))
        val who = ui.card(body)
        ui.fact(who, getString(R.string.share_label_who), req.operator, ltr = true)
        if (req.reason.isNotEmpty()) ui.fact(who, getString(R.string.share_label_reason), req.reason)
        who.removeViewAt(who.childCount - 1) // no divider under the last fact
        val what = ui.card(body)
        what.addView(LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            addView(ui.text(getString(R.string.share_card_what), 16f, top = 0).apply { typeface = Typeface.DEFAULT_BOLD },
                LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
            addView(ui.chip(getString(if (canControl) R.string.share_chip_control else R.string.share_chip_look), if (canControl) ui.warn else ui.ok))
        })
        what.addView(ui.text(getString(R.string.share_screen_what), 14f, ui.muted, top = 10))
        what.addView(ui.text(getString(if (canControl) R.string.share_screen_control_yes else R.string.share_screen_control_no), 14f, ui.muted, top = 8))

        // Buttons stay at the bottom, within thumb reach, whatever the text length.
        val actions = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(ui.dp(16), ui.dp(4), ui.dp(16), ui.dp(16))
            addView(ui.button(getString(R.string.share_action_open)) { askAndroid() })
            addView(ui.button(getString(R.string.share_action_refuse), primary = false) { refuse() },
                LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = ui.dp(10) })
        }
        val outer = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(ui.bg)
            addView(ScrollView(this@ShareRequestActivity).apply { addView(body); isFillViewport = true },
                LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f))
            addView(actions)
        }
        if (Build.VERSION.SDK_INT >= 35) {
            outer.setOnApplyWindowInsetsListener { v, insets ->
                val bars = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout())
                v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
                insets
            }
        }
        setContentView(outer)
        getSystemService(android.app.NotificationManager::class.java).cancel(ScreenShare.REQUEST_NOTIFICATION_ID)
    }

    private fun askAndroid() {
        val mpm = getSystemService(MediaProjectionManager::class.java)
        // Android 14+: the whole screen (so taps land where the operator sees them); Android's dialog
        // still asks and can still be refused.
        val intent = if (Build.VERSION.SDK_INT >= 34) mpm.createScreenCaptureIntent(MediaProjectionConfig.createConfigForDefaultDisplay()) else mpm.createScreenCaptureIntent()
        @Suppress("DEPRECATION")
        startActivityForResult(intent, REQUEST)
    }

    private fun refuse() {
        sessionId?.let { ScreenShare.answer(it, ScreenShare.Answer.DENIED) }
        finish()
    }

    @Deprecated("Activity result API of the framework")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        @Suppress("DEPRECATION") super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != REQUEST) return
        val id = sessionId ?: return finish()
        if (resultCode == RESULT_OK && data != null) {
            ScreenCaptureService.start(this, id, resultCode, data)
        } else {
            ScreenShare.answer(id, ScreenShare.Answer.DENIED)
        }
        finish()
    }

    @Deprecated("Back closes the request: a refusal")
    override fun onBackPressed() {
        refuse()
    }

    override fun onDestroy() {
        if (current?.get() === this) current = null
        super.onDestroy()
    }

    companion object {
        private const val REQUEST = 7
        @Volatile private var current: WeakReference<ShareRequestActivity>? = null

        /** The request ended without an answer here (timeout, cancelled): the screen goes away. */
        fun finishOpen() {
            current?.get()?.let { a -> a.runOnUiThread { a.finish() } }
        }
    }
}
