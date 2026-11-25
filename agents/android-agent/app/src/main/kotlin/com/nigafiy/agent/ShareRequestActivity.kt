package com.nigafiy.agent

import android.app.Activity
import android.content.Intent
import android.media.projection.MediaProjectionConfig
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Bundle
import android.view.WindowInsets
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
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
        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(48, 48, 48, 48) }
        fun text(s: String, size: Float = 16f) = TextView(this).apply { text = s; textSize = size; setPadding(0, 12, 0, 12) }
        root.addView(text(getString(R.string.share_request_title), 20f))
        root.addView(text(getString(R.string.share_screen_who, req.operator)))
        if (req.reason.isNotEmpty()) root.addView(text(getString(R.string.share_screen_reason, req.reason)))
        root.addView(text(getString(R.string.share_screen_what)))
        val controlOn = ControlService.isEnabled(this)
        root.addView(text(getString(if (req.control && controlOn) R.string.share_screen_control_yes else R.string.share_screen_control_no)))
        root.addView(Button(this).apply {
            text = getString(R.string.share_action_open)
            setOnClickListener { askAndroid() }
        })
        root.addView(Button(this).apply {
            text = getString(R.string.share_action_refuse)
            setOnClickListener { refuse() }
        })
        val scroll = ScrollView(this).apply { addView(root) }
        if (Build.VERSION.SDK_INT >= 35) {
            scroll.setOnApplyWindowInsetsListener { v, insets ->
                val bars = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout())
                v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
                insets
            }
        }
        setContentView(scroll)
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
