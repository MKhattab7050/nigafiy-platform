package com.nigafiy.agent

import android.content.Context
import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import com.nigafiy.agent.core.Enrollment
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * The agent's state in its private storage. The credential (`lda_…`) is encrypted with an AES-GCM
 * key from the Android Keystore that never leaves the phone; the rest is not secret.
 */
class Store(ctx: Context) {
    private val prefs: SharedPreferences = ctx.getSharedPreferences("nigafiy", Context.MODE_PRIVATE)

    /** The home address the phone connected at (from the QR code or link). */
    var server: String? get() = prefs.getString("server", null); set(v) = prefs.edit().putString("server", v).apply()
    /** Other addresses of the same server (its Tailscale address), from the heartbeat: ServerAddresses. */
    var otherServers: List<String>
        get() = com.nigafiy.agent.core.ServerAddresses.decode(prefs.getString("other_servers", null))
        set(v) = prefs.edit().putString("other_servers", com.nigafiy.agent.core.ServerAddresses.encode(v)).apply()
    /** The address that answered last (home or another); null = home. */
    var activeServer: String? get() = prefs.getString("active_server", null); set(v) = prefs.edit().putString("active_server", v).apply()
    /** Where to talk to the server now: the address that answered last, else home. */
    val currentServer: String? get() = server?.let { home -> activeServer?.takeIf { it == home || it in otherServers } ?: home }
    val awayFromHome: Boolean get() = server != null && currentServer != server
    var pin: String? get() = prefs.getString("pin", null); set(v) = prefs.edit().putString("pin", v).apply()
    var endpointId: String? get() = prefs.getString("endpoint_id", null); set(v) = prefs.edit().putString("endpoint_id", v).apply()
    var lastContact: Long get() = prefs.getLong("last_contact", 0); set(v) = prefs.edit().putLong("last_contact", v).apply()
    var lastError: String? get() = prefs.getString("last_error", null); set(v) = prefs.edit().putString("last_error", v).apply()
    var heartbeatSeconds: Int get() = prefs.getInt("heartbeat_s", 30); set(v) = prefs.edit().putInt("heartbeat_s", v.coerceIn(10, 600)).apply()
    /** "admin" phones show the dashboard and the network's alerts (the server says so in each heartbeat reply). */
    var phoneRole: String get() = prefs.getString("phone_role", "user") ?: "user"; set(v) = prefs.edit().putString("phone_role", v).apply()
    /** The last network alerts, newest first, as JSON (the Home tab lists them). */
    var recentAlerts: String get() = prefs.getString("recent_alerts", "[]") ?: "[]"; set(v) = prefs.edit().putString("recent_alerts", v).apply()
    val isAdminPhone: Boolean get() = phoneRole == "admin"
    /** What Nigafiy last required (none/low/medium/high), reported back to Fleet. */
    /**
     * The person pressed "Stop everything": nothing runs (no service, no boot or update restart, no
     * gestures) until they open the app again. Written with commit() so it is on disk before the
     * service is stopped.
     */
    var stopped: Boolean
        get() = prefs.getBoolean("stopped", false)
        set(v) { prefs.edit().putBoolean("stopped", v).commit() }
    var passwordComplexity: String? get() = prefs.getString("pw_complexity", null); set(v) = prefs.edit().putString("pw_complexity", v).apply()

    /** An enrollment waiting to run (from the QR provisioning extras or a link). */
    var pendingEnrollment: Enrollment?
        get() {
            val s = prefs.getString("pending_server", null) ?: return null
            val t = prefs.getString("pending_token", null) ?: return null
            return try { Enrollment.of(s, t, prefs.getString("pending_pin", null)) } catch (e: IllegalArgumentException) { null }
        }
        set(v) {
            prefs.edit().putString("pending_server", v?.server).putString("pending_token", v?.token).putString("pending_pin", v?.pin).apply()
        }

    var seenCommands: List<String>
        get() = prefs.getString("seen", "")!!.split(',').filter { it.isNotEmpty() }
        set(v) = prefs.edit().putString("seen", v.joinToString(",")).apply()

    var credential: String?
        get() {
            val enc = prefs.getString("credential_enc", null) ?: return null
            return try {
                val raw = Base64.decode(enc, Base64.NO_WRAP)
                val c = Cipher.getInstance("AES/GCM/NoPadding")
                c.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, raw, 0, 12))
                String(c.doFinal(raw, 12, raw.size - 12), Charsets.UTF_8)
            } catch (e: Exception) {
                null
            }
        }
        set(v) {
            if (v == null) {
                prefs.edit().remove("credential_enc").apply()
                return
            }
            val c = Cipher.getInstance("AES/GCM/NoPadding")
            c.init(Cipher.ENCRYPT_MODE, key())
            val out = c.iv + c.doFinal(v.toByteArray(Charsets.UTF_8))
            prefs.edit().putString("credential_enc", Base64.encodeToString(out, Base64.NO_WRAP)).apply()
        }

    val enrolled: Boolean get() = server != null && credential != null

    fun forget() {
        prefs.edit().clear().apply()
        try { KeyStore.getInstance("AndroidKeyStore").apply { load(null) }.deleteEntry(KEY_ALIAS) } catch (e: Exception) { }
    }

    private fun key(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getEntry(KEY_ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        gen.init(
            KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return gen.generateKey()
    }

    companion object {
        private const val KEY_ALIAS = "nigafiy-credential"
    }
}
