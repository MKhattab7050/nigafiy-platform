package com.nigafiy.agent.core

import kotlin.math.roundToInt

/**
 * The phone controls of regular app mode (docs/features/android.md §12), the parts that run in the
 * JVM tests: what the agent can do, the screen-session request, the input events and how they
 * become gestures, and the frame metadata of the Remote Desktop HTTP frame path.
 *
 * Nothing here is hidden from the person: a screen session needs their MediaProjection consent
 * every time (Android's own dialog and cast indicator), input needs the accessibility service they
 * turned on themselves and only runs inside a session they accepted, files need "All files access"
 * they granted, a message and ringing are notifications on the phone.
 */
object PhoneFeatures {
    const val SCREEN = "screen"
    const val CONTROL = "control"
    const val FILES = "files"
    const val RING = "ring"
    const val MESSAGE = "message"
    /** A drag follows the operator's pointer live (mouse_down / mouse_move / mouse_up), 1.0.8+. */
    const val LIVE_TOUCH = "live_touch"

    /** What this build of the agent implements (reported in each heartbeat; the API shows only these). */
    fun supported(sdkInt: Int): List<String> = buildList {
        add(SCREEN)
        add(CONTROL)
        // MANAGE_EXTERNAL_STORAGE ("All files access") exists from Android 11 (API 30).
        if (sdkInt >= 30) add(FILES)
        add(RING)
        add(MESSAGE)
        add(LIVE_TOUCH)
    }
}

/** Plain text for notifications: control characters become spaces, length is capped. */
object PlainText {
    private val CONTROL = Regex("[\\u0000-\\u0008\\u000b-\\u001f\\u007f\\u202a-\\u202e\\u2066-\\u2069]")
    fun clean(s: String?, max: Int): String = (s ?: "").replace(CONTROL, " ").trim().take(max)
}

/** The rd_session_open payload (remote-desktop/service.ts openOnAgent), as far as a phone uses it. */
data class ScreenSessionRequest(
    val sessionId: String,
    val operator: String,
    val reason: String,
    val consentTimeoutS: Int,
    /** The session's permission profile allows input (the accessibility service must also be on). */
    val control: Boolean,
    val operators: List<String>,
    /** The server's hub takes this phone's live stream (and checks its taps); older servers: HTTP only. */
    val liveStream: Boolean = false,
) {
    companion object {
        fun parse(p: Map<String, Any?>): ScreenSessionRequest {
            val id = AgentCommand.sessionId(p)
            val operator = PlainText.clean(p.str("operator"), 254).ifEmpty { "IT" }
            return ScreenSessionRequest(
                sessionId = id,
                operator = operator,
                reason = PlainText.clean(p.str("reason"), 200),
                consentTimeoutS = (p.long("consent_timeout_s") ?: 60L).toInt().coerceIn(15, 300),
                control = p.bool("control") ?: false,
                operators = AgentCommand.operators(p).ifEmpty { listOf(operator) },
                liveStream = p.bool("phone_stream") ?: false,
            )
        }
    }
}

/** One rd_input event as a phone understands it (normalized 0..1 screen coordinates). */
sealed class InputEvent {
    data class Tap(val x: Double, val y: Double, val double: Boolean) : InputEvent()
    data class LongPress(val x: Double, val y: Double) : InputEvent()
    data class Swipe(val x: Double, val y: Double, val x2: Double, val y2: Double, val durationMs: Int) : InputEvent()
    data class Nav(val action: String) : InputEvent()
    /** A finger held down and moved live (the live stream only): down, moves, up. */
    data class Touch(val phase: Phase, val x: Double, val y: Double) : InputEvent()
    enum class Phase { DOWN, MOVE, UP }
    /** Keyboard, text, wheel, moves: a phone has no such input here (never typed into apps). */
    data class Unsupported(val kind: String) : InputEvent()

    companion object {
        val NAV = setOf("back", "home", "recents")

        private fun coord(p: Map<String, Any?>, k: String): Double {
            val v = (p[k] as? Number)?.toDouble() ?: throw IllegalArgumentException("input without '$k'")
            require(v.isFinite() && v in 0.0..1.0) { "'$k' must be between 0 and 1" }
            return v
        }

        /** The payload's `kind` is the event kind (commands/service.ts renames event_kind). */
        fun parse(p: Map<String, Any?>): InputEvent = when (val kind = p.str("kind") ?: "") {
            "mouse_click" -> {
                val x = coord(p, "x")
                val y = coord(p, "y")
                // A right click is a long press (what a phone does for "more options").
                if (p.str("button") == "right") LongPress(x, y) else Tap(x, y, p.bool("double") ?: false)
            }
            "swipe" -> Swipe(coord(p, "x"), coord(p, "y"), coord(p, "x2"), coord(p, "y2"), ((p.long("duration_ms") ?: 300L).toInt()).coerceIn(Gestures.MIN_MS, Gestures.MAX_MS))
            "nav" -> {
                val a = p.str("nav") ?: ""
                require(a in NAV) { "unknown navigation action '$a'" }
                Nav(a)
            }
            "mouse_down" -> Touch(Phase.DOWN, coord(p, "x"), coord(p, "y"))
            "mouse_move" -> Touch(Phase.MOVE, coord(p, "x"), coord(p, "y"))
            "mouse_up" -> Touch(Phase.UP, coord(p, "x"), coord(p, "y"))
            else -> Unsupported(kind.take(40))
        }
    }
}

/** One stroke of a gesture in screen pixels. */
data class Stroke(val x: Float, val y: Float, val x2: Float, val y2: Float, val startMs: Long, val durationMs: Long)

/** What the accessibility service dispatches: strokes, or one global action (back/home/recents). */
sealed class GesturePlan {
    data class Strokes(val strokes: List<Stroke>) : GesturePlan()
    data class Global(val action: String) : GesturePlan()
}

object Gestures {
    const val TAP_MS = 60
    const val LONG_PRESS_MS = 700
    const val DOUBLE_GAP_MS = 140
    const val MIN_MS = 50
    const val MAX_MS = 3000

    fun px(v: Double, size: Int): Float = (v * (size - 1)).coerceIn(0.0, (size - 1).toDouble()).toFloat()

    /** Maps a normalized event onto a [width]×[height] screen. */
    fun plan(ev: InputEvent, width: Int, height: Int): GesturePlan {
        require(width > 0 && height > 0) { "unknown screen size" }
        return when (ev) {
            is InputEvent.Tap -> {
                val x = px(ev.x, width)
                val y = px(ev.y, height)
                val first = Stroke(x, y, x, y, 0, TAP_MS.toLong())
                GesturePlan.Strokes(if (ev.double) listOf(first, first.copy(startMs = (TAP_MS + DOUBLE_GAP_MS).toLong())) else listOf(first))
            }
            is InputEvent.LongPress -> {
                val x = px(ev.x, width)
                val y = px(ev.y, height)
                GesturePlan.Strokes(listOf(Stroke(x, y, x, y, 0, LONG_PRESS_MS.toLong())))
            }
            is InputEvent.Swipe -> GesturePlan.Strokes(listOf(Stroke(px(ev.x, width), px(ev.y, height), px(ev.x2, width), px(ev.y2, height), 0, ev.durationMs.toLong())))
            is InputEvent.Nav -> GesturePlan.Global(ev.action)
            is InputEvent.Touch -> throw IllegalArgumentException("a live touch needs the live stream")
            is InputEvent.Unsupported -> throw IllegalArgumentException("'${ev.kind}' is not available on an Android phone (tap, long press, swipe, Back, Home and Recent apps only)")
        }
    }
}

/** The rd_capture result (shared-types RemoteDesktopFrame), built from what the capture measured. */
object FrameData {
    fun of(
        jpegBase64: String?,
        byteLength: Int,
        width: Int,
        height: Int,
        sourceWidth: Int,
        sourceHeight: Int,
        quality: Int,
        scale: Double,
        captureMs: Long,
        capturedAt: String,
        unchanged: Boolean,
    ): Map<String, Any?> {
        val m = linkedMapOf<String, Any?>(
            "display_index" to 0,
            "displays" to listOf(linkedMapOf("index" to 0, "name" to "Phone screen", "x" to 0, "y" to 0, "width" to sourceWidth, "height" to sourceHeight, "primary" to true)),
            "width" to width,
            "height" to height,
            "source_width" to sourceWidth,
            "source_height" to sourceHeight,
            "quality" to quality,
            "scale" to (scale * 100).roundToInt() / 100.0,
            "capture_ms" to captureMs,
            "byte_length" to if (unchanged) 0 else byteLength,
            "capture_mode" to "android_mediaprojection",
            "captured_at" to capturedAt,
        )
        if (unchanged) m["unchanged"] = true else m["jpeg_base64"] = jpegBase64
        return m
    }
}
