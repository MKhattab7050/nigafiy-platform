package com.nigafiy.agent.core

/**
 * A small JSON reader and writer for the agent protocol (no library: the APK carries no JSON
 * dependency and the same code runs in the JVM tests).
 *
 * Values are plain Kotlin: `Map<String, Any?>` (insertion order kept), `List<Any?>`, `String`,
 * `Long` (integers), `Double` (anything with a fraction or exponent), `Boolean` and `null`.
 */
object Json {
    class ParseError(message: String) : IllegalArgumentException(message)

    fun parse(text: String): Any? {
        val p = Parser(text)
        p.ws()
        val v = p.value(0)
        p.ws()
        if (p.i != text.length) throw ParseError("trailing data at ${p.i}")
        return v
    }

    fun parseObject(text: String): Map<String, Any?> =
        parse(text) as? Map<String, Any?> ?: throw ParseError("not a JSON object")

    fun write(value: Any?): String = StringBuilder().also { write(it, value) }.toString()

    private fun write(sb: StringBuilder, v: Any?) {
        when (v) {
            null -> sb.append("null")
            is String -> quote(sb, v)
            is Boolean -> sb.append(v)
            is Int, is Long, is Short, is Byte -> sb.append(v.toString())
            is Double -> if (v.isFinite()) sb.append(if (v == Math.floor(v) && Math.abs(v) < 1e15) v.toLong().toString() else v.toString()) else sb.append("null")
            is Float -> write(sb, v.toDouble())
            is Map<*, *> -> {
                sb.append('{')
                var first = true
                for ((k, value) in v) {
                    if (!first) sb.append(',')
                    first = false
                    quote(sb, k.toString())
                    sb.append(':')
                    write(sb, value)
                }
                sb.append('}')
            }
            is Iterable<*> -> {
                sb.append('[')
                var first = true
                for (item in v) {
                    if (!first) sb.append(',')
                    first = false
                    write(sb, item)
                }
                sb.append(']')
            }
            is Array<*> -> write(sb, v.toList())
            else -> quote(sb, v.toString())
        }
    }

    private fun quote(sb: StringBuilder, s: String) {
        sb.append('"')
        for (c in s) {
            when (c) {
                '"' -> sb.append("\\\"")
                '\\' -> sb.append("\\\\")
                '\n' -> sb.append("\\n")
                '\r' -> sb.append("\\r")
                '\t' -> sb.append("\\t")
                '\b' -> sb.append("\\b")
                '\u000c' -> sb.append("\\f")
                else -> if (c < ' ' || c == ' ' || c == ' ') sb.append(String.format("\\u%04x", c.code)) else sb.append(c)
            }
        }
        sb.append('"')
    }

    private class Parser(val s: String) {
        var i = 0

        fun ws() {
            while (i < s.length && (s[i] == ' ' || s[i] == '\n' || s[i] == '\r' || s[i] == '\t')) i++
        }

        fun value(depth: Int): Any? {
            if (depth > 64) throw ParseError("nested too deeply")
            if (i >= s.length) throw ParseError("unexpected end")
            return when (val c = s[i]) {
                '{' -> obj(depth)
                '[' -> arr(depth)
                '"' -> str()
                't' -> lit("true", true)
                'f' -> lit("false", false)
                'n' -> lit("null", null)
                else -> if (c == '-' || c.isDigit()) num() else throw ParseError("unexpected '$c' at $i")
            }
        }

        fun lit(word: String, v: Any?): Any? {
            if (!s.startsWith(word, i)) throw ParseError("bad literal at $i")
            i += word.length
            return v
        }

        fun obj(depth: Int): Map<String, Any?> {
            val m = LinkedHashMap<String, Any?>()
            i++
            ws()
            if (i < s.length && s[i] == '}') { i++; return m }
            while (true) {
                ws()
                if (i >= s.length || s[i] != '"') throw ParseError("expected a key at $i")
                val k = str()
                ws()
                if (i >= s.length || s[i] != ':') throw ParseError("expected ':' at $i")
                i++
                ws()
                m[k] = value(depth + 1)
                ws()
                if (i >= s.length) throw ParseError("unexpected end")
                if (s[i] == ',') { i++; continue }
                if (s[i] == '}') { i++; return m }
                throw ParseError("expected ',' or '}' at $i")
            }
        }

        fun arr(depth: Int): List<Any?> {
            val l = ArrayList<Any?>()
            i++
            ws()
            if (i < s.length && s[i] == ']') { i++; return l }
            while (true) {
                ws()
                l.add(value(depth + 1))
                ws()
                if (i >= s.length) throw ParseError("unexpected end")
                if (s[i] == ',') { i++; continue }
                if (s[i] == ']') { i++; return l }
                throw ParseError("expected ',' or ']' at $i")
            }
        }

        fun str(): String {
            val sb = StringBuilder()
            i++
            while (true) {
                if (i >= s.length) throw ParseError("unterminated string")
                val c = s[i++]
                when {
                    c == '"' -> return sb.toString()
                    c == '\\' -> {
                        if (i >= s.length) throw ParseError("bad escape")
                        when (val e = s[i++]) {
                            '"' -> sb.append('"')
                            '\\' -> sb.append('\\')
                            '/' -> sb.append('/')
                            'b' -> sb.append('\b')
                            'f' -> sb.append('\u000c')
                            'n' -> sb.append('\n')
                            'r' -> sb.append('\r')
                            't' -> sb.append('\t')
                            'u' -> {
                                if (i + 4 > s.length) throw ParseError("bad unicode escape")
                                sb.append(s.substring(i, i + 4).toIntOrNull(16)?.toChar() ?: throw ParseError("bad unicode escape"))
                                i += 4
                            }
                            else -> throw ParseError("bad escape '\\$e'")
                        }
                    }
                    c < ' ' -> throw ParseError("control character in string")
                    else -> sb.append(c)
                }
            }
        }

        fun num(): Any {
            val start = i
            if (s[i] == '-') i++
            while (i < s.length && s[i].isDigit()) i++
            var fraction = false
            if (i < s.length && s[i] == '.') { fraction = true; i++; while (i < s.length && s[i].isDigit()) i++ }
            if (i < s.length && (s[i] == 'e' || s[i] == 'E')) {
                fraction = true
                i++
                if (i < s.length && (s[i] == '+' || s[i] == '-')) i++
                while (i < s.length && s[i].isDigit()) i++
            }
            val t = s.substring(start, i)
            if (t == "-" || t.isEmpty()) throw ParseError("bad number at $start")
            return if (fraction) t.toDouble() else t.toLongOrNull() ?: t.toDouble()
        }
    }
}

/** Typed reads from a parsed JSON object. */
fun Map<String, Any?>.str(key: String): String? = this[key] as? String
fun Map<String, Any?>.long(key: String): Long? = when (val v = this[key]) { is Long -> v; is Double -> if (v == Math.floor(v)) v.toLong() else null; else -> null }
fun Map<String, Any?>.bool(key: String): Boolean? = this[key] as? Boolean
@Suppress("UNCHECKED_CAST")
fun Map<String, Any?>.obj(key: String): Map<String, Any?>? = this[key] as? Map<String, Any?>
@Suppress("UNCHECKED_CAST")
fun Map<String, Any?>.list(key: String): List<Any?>? = this[key] as? List<Any?>
