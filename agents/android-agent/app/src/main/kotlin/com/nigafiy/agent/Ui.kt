package com.nigafiy.agent

import android.content.Context
import android.content.res.ColorStateList
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.text.TextUtils
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView

/**
 * The app's look, built in code (no extra libraries): a teal header, rounded cards, status rows with
 * coloured chips and two button styles. Light and dark follow the phone's setting.
 */
class Ui(private val ctx: Context) {
    val dark = (ctx.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES

    val brand = Color.parseColor("#0F766E")
    private val brandDeep = Color.parseColor("#134E4A")
    val bg = if (dark) Color.parseColor("#0B1214") else Color.parseColor("#F3F6F6")
    private val card = if (dark) Color.parseColor("#141E21") else Color.WHITE
    private val line = if (dark) Color.parseColor("#22313A") else Color.parseColor("#E3EAEA")
    val fg = if (dark) Color.parseColor("#E8F0F0") else Color.parseColor("#10201F")
    val muted = if (dark) Color.parseColor("#93A6A6") else Color.parseColor("#5B6F6E")
    val ok = Color.parseColor("#16A34A")
    val warn = Color.parseColor("#D97706")
    val bad = Color.parseColor("#DC2626")

    fun dp(v: Int): Int = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v.toFloat(), ctx.resources.displayMetrics).toInt()

    private fun round(color: Int, radius: Int, stroke: Int? = null) = GradientDrawable().apply {
        setColor(color)
        cornerRadius = dp(radius).toFloat()
        stroke?.let { setStroke(dp(1), it) }
    }

    private fun lp(w: Int = LinearLayout.LayoutParams.MATCH_PARENT, h: Int = LinearLayout.LayoutParams.WRAP_CONTENT, top: Int = 0, bottom: Int = 0) =
        LinearLayout.LayoutParams(w, h).apply { topMargin = dp(top); bottomMargin = dp(bottom) }

    /** The header band: shield, app name, and a line under it (status or a hint). */
    fun header(title: String, subtitle: String, statusColor: Int?): View = LinearLayout(ctx).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
        setPadding(dp(20), dp(22), dp(20), dp(22))
        background = GradientDrawable(GradientDrawable.Orientation.TL_BR, intArrayOf(brand, brandDeep)).apply { cornerRadius = dp(20).toFloat() }
        addView(ImageView(ctx).apply {
            setImageResource(R.drawable.ic_nigafiy)
            background = round(Color.WHITE, 14)
            setPadding(dp(8), dp(8), dp(8), dp(8))
        }, LinearLayout.LayoutParams(dp(52), dp(52)))
        addView(LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(14), 0, 0, 0)
            addView(TextView(ctx).apply {
                text = title
                setTextColor(Color.WHITE)
                textSize = 20f
                typeface = Typeface.DEFAULT_BOLD
            })
            addView(LinearLayout(ctx).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                setPadding(0, dp(4), 0, 0)
                if (statusColor != null) {
                    addView(View(ctx).apply { background = round(statusColor, 5).apply { setStroke(dp(2), Color.parseColor("#33FFFFFF")) } }, LinearLayout.LayoutParams(dp(10), dp(10)).apply { marginEnd = dp(8) })
                }
                addView(TextView(ctx).apply {
                    text = subtitle
                    setTextColor(Color.parseColor("#D9F2EF"))
                    textSize = 13f
                })
            })
        }, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
    }.also { it.layoutParams = lp(bottom = 16) }

    /** A rounded card with an optional title; returns its body to add rows to. */
    fun card(parent: LinearLayout, title: String? = null, hint: String? = null): LinearLayout {
        val c = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            background = round(card, 18, line)
            setPadding(dp(18), dp(16), dp(18), dp(16))
            elevation = dp(1).toFloat()
        }
        if (title != null) c.addView(TextView(ctx).apply {
            text = title
            setTextColor(fg)
            textSize = 16f
            typeface = Typeface.DEFAULT_BOLD
        })
        if (hint != null) c.addView(TextView(ctx).apply {
            text = hint
            setTextColor(muted)
            textSize = 13f
            setPadding(0, dp(4), 0, dp(4))
        })
        parent.addView(c, lp(bottom = 14))
        return c
    }

    fun text(s: String, size: Float = 14f, color: Int = fg, ltr: Boolean = false, top: Int = 6) = TextView(ctx).apply {
        text = s
        textSize = size
        setTextColor(color)
        setPadding(0, dp(top), 0, dp(2))
        setLineSpacing(0f, 1.15f)
        if (ltr) textDirection = View.TEXT_DIRECTION_LTR
    }

    /** One fact: a label, its value under it (left-to-right when it is an address or an id). */
    fun fact(parent: LinearLayout, label: String, value: String, ltr: Boolean = false) {
        parent.addView(LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(0, dp(10), 0, dp(10))
            addView(TextView(ctx).apply { text = label; textSize = 12f; setTextColor(muted) })
            addView(TextView(ctx).apply {
                text = value
                textSize = 15f
                setTextColor(fg)
                if (ltr) { textDirection = View.TEXT_DIRECTION_LTR; textAlignment = View.TEXT_ALIGNMENT_VIEW_START }
                if (ltr) { ellipsize = TextUtils.TruncateAt.MIDDLE; maxLines = 2 }
            })
        })
        divider(parent)
    }

    fun divider(parent: LinearLayout) {
        parent.addView(View(ctx).apply { setBackgroundColor(line) }, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(1)))
    }

    /** A control row: title, a coloured chip with its state, an explanation, and an optional button. */
    fun control(parent: LinearLayout, title: String, on: Boolean?, chip: String, detail: String, action: String? = null, onClick: (() -> Unit)? = null) {
        val row = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL; setPadding(0, dp(12), 0, dp(12)) }
        row.addView(LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            addView(TextView(ctx).apply { text = title; textSize = 15f; setTextColor(fg); typeface = Typeface.DEFAULT_BOLD }, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
            addView(chip(chip, when (on) { true -> ok; false -> warn; null -> muted }))
        })
        row.addView(text(detail, 13f, muted, top = 4))
        if (action != null && onClick != null) row.addView(button(action, primary = on == false, onClick = onClick), lp(top = 10))
        parent.addView(row)
    }

    fun chip(s: String, color: Int) = TextView(ctx).apply {
        text = s
        textSize = 12f
        typeface = Typeface.DEFAULT_BOLD
        setTextColor(color)
        background = round(Color.argb(if (dark) 48 else 28, Color.red(color), Color.green(color), Color.blue(color)), 12)
        setPadding(dp(10), dp(4), dp(10), dp(4))
    }

    fun button(label: String, primary: Boolean = true, onClick: () -> Unit) = Button(ctx).apply {
        text = label
        isAllCaps = false
        textSize = 15f
        typeface = Typeface.DEFAULT_BOLD
        stateListAnimator = null
        minHeight = dp(48)
        setTextColor(if (primary) Color.WHITE else brand)
        val shape = round(if (primary) brand else Color.TRANSPARENT, 14, if (primary) null else brand)
        background = RippleDrawable(ColorStateList.valueOf(Color.parseColor(if (primary) "#33FFFFFF" else "#220F766E")), shape, null)
        setOnClickListener { onClick() }
    }

    fun addButton(parent: LinearLayout, label: String, primary: Boolean = true, onClick: () -> Unit) {
        parent.addView(button(label, primary, onClick), lp(top = 10))
    }

    fun styleField(e: EditText) {
        e.background = round(if (dark) Color.parseColor("#0F181A") else Color.parseColor("#F7FAFA"), 12, line)
        e.setPadding(dp(14), dp(12), dp(14), dp(12))
        e.setTextColor(fg)
        e.setHintTextColor(muted)
        e.textSize = 15f
        e.layoutParams = lp(top = 10)
    }

    /** A red or amber note (an error, a warning). */
    fun note(parent: LinearLayout, s: String, color: Int = bad) {
        parent.addView(TextView(ctx).apply {
            text = s
            textSize = 13f
            setTextColor(color)
            background = round(Color.argb(if (dark) 40 else 22, Color.red(color), Color.green(color), Color.blue(color)), 12)
            setPadding(dp(12), dp(10), dp(12), dp(10))
        }, lp(top = 10))
    }
}
