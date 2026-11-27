package com.nigafiy.agent

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.content.ComponentName
import android.content.Context
import android.graphics.Color
import android.graphics.Path
import android.graphics.PixelFormat
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.view.accessibility.AccessibilityEvent
import android.widget.TextView
import com.nigafiy.agent.core.GesturePlan
import com.nigafiy.agent.core.InputEvent
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Remote control, only if the person turned it on in Settings → Accessibility → Nigafiy, and only
 * while a screen-sharing session they accepted runs with control allowed. It performs gestures
 * (dispatchGesture) and Back / Home / Recent apps (performGlobalAction), nothing else: the service
 * is declared without window content access and with no event types, so it never sees what is on
 * the screen or what anyone types. While control is possible a bar stays on top of the screen:
 * "Nigafiy is controlling this phone".
 */
class ControlService : AccessibilityService() {
    private val main = Handler(Looper.getMainLooper())
    private var bar: View? = null

    override fun onServiceConnected() {
        super.onServiceConnected()
        instance = this
        main.post { updateBar() }
    }

    /** No event types are subscribed (accessibility_service.xml): nothing arrives, nothing is read. */
    override fun onAccessibilityEvent(event: AccessibilityEvent?) = Unit

    override fun onInterrupt() = Unit

    override fun onUnbind(intent: android.content.Intent?): Boolean {
        if (instance === this) instance = null
        main.post { removeBar() }
        return super.onUnbind(intent)
    }

    override fun onDestroy() {
        if (instance === this) instance = null
        removeBar()
        super.onDestroy()
    }

    /** Runs [plan]; true when Android completed the gesture. Called off the main thread. */
    fun perform(plan: GesturePlan): Boolean = if (Store(this).stopped) false else when (plan) {
        is GesturePlan.Global -> {
            val action = when (plan.action) {
                "back" -> GLOBAL_ACTION_BACK
                "home" -> GLOBAL_ACTION_HOME
                else -> GLOBAL_ACTION_RECENTS
            }
            performGlobalAction(action)
        }
        is GesturePlan.Strokes -> {
            val b = GestureDescription.Builder()
            for (s in plan.strokes) {
                val path = Path().apply { moveTo(s.x, s.y); lineTo(s.x2, s.y2) }
                b.addStroke(GestureDescription.StrokeDescription(path, s.startMs, s.durationMs))
            }
            val done = CountDownLatch(1)
            val ok = AtomicBoolean(false)
            val started = AtomicBoolean(false)
            main.post {
                started.set(dispatchGesture(b.build(), object : GestureResultCallback() {
                    override fun onCompleted(d: GestureDescription?) { ok.set(true); done.countDown() }
                    override fun onCancelled(d: GestureDescription?) { done.countDown() }
                }, main))
                if (!started.get()) done.countDown()
            }
            val total = plan.strokes.maxOf { it.startMs + it.durationMs }
            done.await(total + 3_000, TimeUnit.MILLISECONDS) && ok.get()
        }
    }

    // ── A live finger (the live stream's mouse_down / mouse_move / mouse_up) ──
    // Each move continues the stroke (StrokeDescription.continueStroke), so a list scrolls and a
    // slider moves while the operator drags, instead of replaying the whole swipe after they let go.
    private var liveStroke: GestureDescription.StrokeDescription? = null
    private var liveX = 0f
    private var liveY = 0f
    private var liveAt = 0L

    /** Called off the main thread, in order; true when Android took the segment. */
    fun touch(phase: InputEvent.Phase, x: Float, y: Float): Boolean {
        if (Store(this).stopped) return false
        val now = System.currentTimeMillis()
        val segment: GestureDescription.StrokeDescription = synchronized(this) {
            val prev = liveStroke
            when (phase) {
                InputEvent.Phase.DOWN -> {
                    val path = Path().apply { moveTo(x, y) }
                    GestureDescription.StrokeDescription(path, 0, LIVE_FIRST_MS, true).also { liveStroke = it }
                }
                InputEvent.Phase.MOVE, InputEvent.Phase.UP -> {
                    if (prev == null) return false
                    val path = Path().apply { moveTo(liveX, liveY); lineTo(x, y) }
                    val dur = (now - liveAt).coerceIn(LIVE_MIN_MS, LIVE_MAX_MS)
                    val last = phase == InputEvent.Phase.UP
                    prev.continueStroke(path, 0, dur, !last).also { liveStroke = if (last) null else it }
                }
            }.also { liveX = x; liveY = y; liveAt = now }
        }
        val gesture = GestureDescription.Builder().addStroke(segment).build()
        main.post { dispatchGesture(gesture, null, null) }
        return true
    }

    private fun updateBar() {
        val a = ScreenShare.active
        if (a != null && a.control) showBar(a.operator) else removeBar()
    }

    private fun showBar(operator: String) {
        val text = getString(R.string.controlling_bar, operator)
        (bar as? TextView)?.let { it.text = text; return }
        val wm = getSystemService(WindowManager::class.java)
        val v = TextView(this).apply {
            this.text = text
            textSize = 13f
            setTextColor(Color.WHITE)
            setBackgroundColor(Color.argb(230, 183, 28, 28))
            setPadding(24, 10, 24, 10)
            gravity = Gravity.CENTER
        }
        val lp = WindowManager.LayoutParams(
            WindowManager.LayoutParams.MATCH_PARENT,
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE or WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
            PixelFormat.TRANSLUCENT,
        ).apply { gravity = Gravity.TOP }
        try {
            wm.addView(v, lp)
            bar = v
        } catch (_: Exception) {
            bar = null
        }
    }

    private fun removeBar() {
        val v = bar ?: return
        bar = null
        try { getSystemService(WindowManager::class.java).removeView(v) } catch (_: Exception) { }
    }

    companion object {
        private const val LIVE_FIRST_MS = 1L
        private const val LIVE_MIN_MS = 8L
        private const val LIVE_MAX_MS = 120L
        @Volatile var instance: ControlService? = null
            private set

        /** Whether the person turned the service on (Settings.Secure, readable by any app). */
        fun isEnabled(ctx: Context): Boolean {
            val me = ComponentName(ctx, ControlService::class.java)
            val list = Settings.Secure.getString(ctx.contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES) ?: return false
            return list.split(':').any { ComponentName.unflattenFromString(it) == me }
        }

        /** Shows or removes the "controlling" bar after a session started or ended. */
        fun refreshIndicator(ctx: Context) {
            val s = instance ?: return
            s.main.post { s.updateBar() }
        }
    }
}
