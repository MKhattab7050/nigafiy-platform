package com.nigafiy.agent.core

import java.time.LocalDate
import java.time.ZoneOffset
import java.time.format.DateTimeParseException
import java.time.temporal.ChronoUnit

/** How the agent manages the phone. Device Admin (deprecated by Google) is not offered. */
enum class Mode(val wire: String) {
    REGULAR("regular"),
    DEVICE_OWNER("device_owner"),
}

/**
 * `DevicePolicyManager.getStorageEncryptionStatus()` values (android.app.admin.DevicePolicyManager):
 * 0 UNSUPPORTED, 1 INACTIVE, 2 ACTIVATING, 3 ACTIVE, 4 ACTIVE_DEFAULT_KEY, 5 ACTIVE_PER_USER.
 */
object EncryptionStatus {
    const val UNSUPPORTED = 0
    const val INACTIVE = 1
    const val ACTIVATING = 2
    const val ACTIVE = 3
    const val ACTIVE_DEFAULT_KEY = 4
    const val ACTIVE_PER_USER = 5
}

/**
 * "Unknown sources" on Android 8+ is a per-app grant ("Install unknown apps"), not one switch.
 * [restrictedByPolicy]: a Device Owner agent read `DISALLOW_INSTALL_UNKNOWN_SOURCES_GLOBALLY`.
 * [appsAllowed]: the apps that may install unknown apps (app-op `request_install_packages`), or
 * null when Android did not let the agent read them ([error] says why).
 */
data class UnknownSourcesFacts(val restrictedByPolicy: Boolean?, val appsAllowed: List<String>?, val error: String?)

/** Raw facts read on the phone; each null is a fact Android did not give (shown as "not measured"). */
data class SecurityFacts(
    val screenLockSet: Boolean?,
    val encryptionStatus: Int?,
    val securityPatch: String?,
    val developerOptions: Boolean?,
    val usbDebugging: Boolean?,
    val unknownSources: UnknownSourcesFacts,
)

/** One compliance measurement in the shape the API's `securityEvidenceSchema` takes. */
data class Evidence(
    val check: String,
    val subject: String,
    val state: String,
    val value: String,
    val source: String,
    val measuredAt: String,
    val reason: String? = null,
) {
    fun toJson(): Map<String, Any?> = linkedMapOf<String, Any?>(
        "check" to check,
        "subject" to subject,
        "state" to state,
        "value" to value.take(300),
        "source" to source,
        "measured_at" to measuredAt,
    ).also { if (reason != null) it["reason"] = reason.take(300) }
}

object Compliance {
    /** A security patch older than this many days fails "OS / security updates". */
    const val PATCH_MAX_AGE_DAYS = 90L

    fun evidence(f: SecurityFacts, measuredAt: String, today: LocalDate = LocalDate.now(ZoneOffset.UTC)): List<Evidence> {
        val out = ArrayList<Evidence>()
        val ev = { check: String, subject: String, state: String, value: String, source: String, reason: String? ->
            out.add(Evidence(check, subject, state, value, source, measuredAt, reason))
        }

        when (f.screenLockSet) {
            true -> ev("screen_lock", "Screen lock", "pass", "PIN, pattern or password set", "KeyguardManager.isDeviceSecure", null)
            false -> ev("screen_lock", "Screen lock", "fail", "none (swipe or no lock)", "KeyguardManager.isDeviceSecure", "no PIN, pattern or password protects the phone")
            null -> ev("screen_lock", "Screen lock", "unknown", "not read", "KeyguardManager.isDeviceSecure", "Android did not report the screen lock state")
        }

        val encSource = "DevicePolicyManager.getStorageEncryptionStatus"
        when (f.encryptionStatus) {
            EncryptionStatus.ACTIVE -> ev("disk_encryption", "Storage", "pass", "encrypted", encSource, null)
            EncryptionStatus.ACTIVE_PER_USER -> ev("disk_encryption", "Storage", "pass", "file-based encryption (per user)", encSource, null)
            EncryptionStatus.ACTIVE_DEFAULT_KEY -> ev("disk_encryption", "Storage", "warn", "encrypted with the default key", encSource, "no screen lock protects the encryption key")
            EncryptionStatus.ACTIVATING -> ev("disk_encryption", "Storage", "warn", "encryption in progress", encSource, "encryption has not finished")
            EncryptionStatus.INACTIVE -> ev("disk_encryption", "Storage", "fail", "not encrypted", encSource, "storage encryption is off")
            EncryptionStatus.UNSUPPORTED -> ev("disk_encryption", "Storage", "fail", "not supported", encSource, "this phone does not support storage encryption")
            null -> ev("disk_encryption", "Storage", "unknown", "not read", encSource, "Android did not report the encryption status")
            else -> ev("disk_encryption", "Storage", "unknown", "status ${f.encryptionStatus}", encSource, "unknown encryption status value")
        }

        val patchSource = "Build.VERSION.SECURITY_PATCH"
        val patch = f.securityPatch?.trim().orEmpty()
        val patchDate = try { if (patch.isEmpty()) null else LocalDate.parse(patch) } catch (e: DateTimeParseException) { null }
        if (patchDate == null) {
            ev("os_updates", "Security patch level", "unknown", patch.ifEmpty { "not reported" }, patchSource, "the security patch level is not a date")
        } else {
            val age = ChronoUnit.DAYS.between(patchDate, today).coerceAtLeast(0)
            if (age > PATCH_MAX_AGE_DAYS) {
                ev("os_updates", "Security patch level", "fail", "$patch ($age days old)", patchSource, "older than $PATCH_MAX_AGE_DAYS days")
            } else {
                ev("os_updates", "Security patch level", "pass", "$patch ($age days old)", patchSource, null)
            }
        }

        when (f.developerOptions) {
            true -> ev("developer_options", "Developer options", "fail", "on", "Settings.Global.DEVELOPMENT_SETTINGS_ENABLED", "developer options are switched on")
            false -> ev("developer_options", "Developer options", "pass", "off", "Settings.Global.DEVELOPMENT_SETTINGS_ENABLED", null)
            null -> ev("developer_options", "Developer options", "unknown", "not read", "Settings.Global.DEVELOPMENT_SETTINGS_ENABLED", "the setting could not be read")
        }
        when (f.usbDebugging) {
            true -> ev("usb_debugging", "USB debugging", "fail", "on", "Settings.Global.ADB_ENABLED", "USB debugging (adb) is switched on")
            false -> ev("usb_debugging", "USB debugging", "pass", "off", "Settings.Global.ADB_ENABLED", null)
            null -> ev("usb_debugging", "USB debugging", "unknown", "not read", "Settings.Global.ADB_ENABLED", "the setting could not be read")
        }

        val u = f.unknownSources
        when {
            u.restrictedByPolicy == true ->
                ev("unknown_sources", "Install unknown apps", "pass", "blocked by Nigafiy policy", "UserManager DISALLOW_INSTALL_UNKNOWN_SOURCES_GLOBALLY", null)
            u.appsAllowed != null && u.appsAllowed.isEmpty() ->
                ev("unknown_sources", "Install unknown apps", "pass", "no app may install unknown apps", "AppOpsManager request_install_packages", null)
            u.appsAllowed != null ->
                ev("unknown_sources", "Install unknown apps", "fail", u.appsAllowed.sorted().joinToString(", "), "AppOpsManager request_install_packages", "${u.appsAllowed.size} app(s) may install apps from unknown sources")
            else ->
                ev("unknown_sources", "Install unknown apps", "unknown", "not read", "AppOpsManager request_install_packages", u.error ?: "Android did not let the agent read the per-app grants")
        }
        return out
    }
}
