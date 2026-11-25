package com.nigafiy.agent

import android.Manifest
import android.app.ActivityManager
import android.app.AppOpsManager
import android.app.KeyguardManager
import android.app.NotificationManager
import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ApplicationInfo
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.BatteryManager
import android.os.Build
import android.os.Environment
import android.os.PowerManager
import android.os.StatFs
import android.os.SystemClock
import android.os.UserManager
import android.provider.Settings
import com.nigafiy.agent.admin.NigafiyAdminReceiver
import com.nigafiy.agent.core.DeviceInfo
import com.nigafiy.agent.core.InstalledApp
import com.nigafiy.agent.core.Mode
import com.nigafiy.agent.core.NetInterface
import com.nigafiy.agent.core.SecurityFacts
import com.nigafiy.agent.core.UnknownSourcesFacts
import java.net.Inet4Address

/** Reads the facts of docs/features/android.md §1 ("Regular app" column) with framework APIs only. */
class Facts(private val ctx: Context, private val store: Store) {
    private val dpm = ctx.getSystemService(DevicePolicyManager::class.java)
    private val admin = ComponentName(ctx, NigafiyAdminReceiver::class.java)

    fun mode(): Mode = if (dpm.isDeviceOwnerApp(ctx.packageName)) Mode.DEVICE_OWNER else Mode.REGULAR

    private inline fun <T> read(f: () -> T): T? = try { f() } catch (e: Exception) { null }

    fun device(withApps: Boolean): DeviceInfo {
        val mode = mode()
        val am = ctx.getSystemService(ActivityManager::class.java)
        val mem = ActivityManager.MemoryInfo().also { am.getMemoryInfo(it) }
        val stat = read { StatFs(Environment.getDataDirectory().path) }
        val battery = read { ctx.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED)) }
        val level = battery?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
        val scale = battery?.getIntExtra(BatteryManager.EXTRA_SCALE, -1) ?: -1
        val status = battery?.getIntExtra(BatteryManager.EXTRA_STATUS, -1) ?: -1
        val (network, ip, ifaces) = network()
        val pm = ctx.getSystemService(PowerManager::class.java)
        val nm = ctx.getSystemService(NotificationManager::class.java)
        return DeviceInfo(
            deviceName = read { Settings.Global.getString(ctx.contentResolver, Settings.Global.DEVICE_NAME) } ?: Build.MODEL,
            manufacturer = Build.MANUFACTURER,
            model = Build.MODEL,
            androidRelease = Build.VERSION.RELEASE,
            sdkInt = Build.VERSION.SDK_INT,
            securityPatch = Build.VERSION.SECURITY_PATCH,
            abi = Build.SUPPORTED_ABIS.firstOrNull(),
            ramTotalBytes = mem.totalMem.takeIf { it > 0 },
            ramAvailBytes = mem.availMem.takeIf { it >= 0 },
            storageTotalBytes = stat?.totalBytes,
            storageFreeBytes = stat?.availableBytes,
            batteryPct = if (level >= 0 && scale > 0) level * 100 / scale else null,
            charging = if (status < 0) null else status == BatteryManager.BATTERY_STATUS_CHARGING || status == BatteryManager.BATTERY_STATUS_FULL,
            network = network,
            primaryIpv4 = ip,
            interfaces = ifaces,
            apps = if (withApps) read { apps() } else null,
            uptimeSeconds = SystemClock.elapsedRealtime() / 1000,
            mode = mode,
            cameraDisabled = if (mode == Mode.DEVICE_OWNER) read { dpm.getCameraDisabled(admin) } else null,
            passwordComplexityRequired = if (mode == Mode.DEVICE_OWNER) store.passwordComplexity ?: "none" else null,
            batteryOptimisationExempt = read { pm.isIgnoringBatteryOptimizations(ctx.packageName) },
            notificationsAllowed = read { nm.areNotificationsEnabled() },
        )
    }

    private fun network(): Triple<String?, String?, List<NetInterface>> {
        val cm = ctx.getSystemService(ConnectivityManager::class.java) ?: return Triple(null, null, emptyList())
        val active = read { cm.activeNetwork } ?: return Triple("none", null, emptyList())
        val caps = read { cm.getNetworkCapabilities(active) }
        val kind = when {
            caps == null -> "other"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN) -> "vpn"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "cellular"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "ethernet"
            else -> "other"
        }
        val ifaces = ArrayList<NetInterface>()
        var ip: String? = null
        for (n in read { cm.allNetworks.toList() } ?: emptyList()) {
            val lp = read { cm.getLinkProperties(n) } ?: continue
            val name = lp.interfaceName ?: continue
            val addrs = lp.linkAddresses.map { "${it.address.hostAddress}/${it.prefixLength}" }
            ifaces.add(NetInterface(name, addrs))
            if (n == active) ip = lp.linkAddresses.map { it.address }.firstOrNull { it is Inet4Address }?.hostAddress
        }
        return Triple(kind, ip, ifaces)
    }

    @Suppress("DEPRECATION")
    private fun installedPackages(flags: Int): List<PackageInfo> {
        val pm = ctx.packageManager
        return if (Build.VERSION.SDK_INT >= 33) pm.getInstalledPackages(PackageManager.PackageInfoFlags.of(flags.toLong())) else pm.getInstalledPackages(flags)
    }

    private fun apps(): List<InstalledApp> {
        val pm = ctx.packageManager
        return installedPackages(0).mapNotNull { p ->
            val ai = p.applicationInfo ?: return@mapNotNull null
            InstalledApp(
                label = ai.loadLabel(pm).toString(),
                packageName = p.packageName,
                versionName = p.versionName,
                system = (ai.flags and ApplicationInfo.FLAG_SYSTEM) != 0,
            )
        }
    }

    fun security(): SecurityFacts {
        val km = ctx.getSystemService(KeyguardManager::class.java)
        val cr = ctx.contentResolver
        return SecurityFacts(
            screenLockSet = read { km.isDeviceSecure },
            encryptionStatus = read { dpm.storageEncryptionStatus },
            securityPatch = Build.VERSION.SECURITY_PATCH,
            developerOptions = read { Settings.Global.getInt(cr, Settings.Global.DEVELOPMENT_SETTINGS_ENABLED, 0) == 1 },
            usbDebugging = read { Settings.Global.getInt(cr, Settings.Global.ADB_ENABLED, 0) == 1 },
            unknownSources = unknownSources(),
        )
    }

    /**
     * Android 8+ has no single "unknown sources" switch: each app holds the "Install unknown apps"
     * grant (app-op request_install_packages). Android lets an app read that op only for itself
     * (AppOpsService checks UPDATE_APP_OPS_STATS for any other uid), so the per-app list is read
     * where Android allows it and otherwise reported as not measured with that reason. A Device
     * Owner reads the global user restriction.
     */
    private fun unknownSources(): UnknownSourcesFacts {
        val um = ctx.getSystemService(UserManager::class.java)
        val restricted = read {
            um.hasUserRestriction(UserManager.DISALLOW_INSTALL_UNKNOWN_SOURCES) ||
                (Build.VERSION.SDK_INT >= 29 && um.hasUserRestriction(UserManager.DISALLOW_INSTALL_UNKNOWN_SOURCES_GLOBALLY))
        }
        val ops = ctx.getSystemService(AppOpsManager::class.java)
        val allowed = ArrayList<String>()
        try {
            for (p in installedPackages(PackageManager.GET_PERMISSIONS)) {
                if (p.packageName == ctx.packageName) continue
                if (p.requestedPermissions?.contains(Manifest.permission.REQUEST_INSTALL_PACKAGES) != true) continue
                val uid = p.applicationInfo?.uid ?: continue
                val mode = if (Build.VERSION.SDK_INT >= 29) ops.unsafeCheckOpNoThrow("android:request_install_packages", uid, p.packageName)
                else @Suppress("DEPRECATION") ops.checkOpNoThrow("android:request_install_packages", uid, p.packageName)
                if (mode == AppOpsManager.MODE_ALLOWED) allowed.add(p.packageName)
            }
        } catch (e: SecurityException) {
            return UnknownSourcesFacts(restricted, null, "Android does not let an app read other apps' \"Install unknown apps\" grant")
        }
        // An empty list is not proof: without the permission above Android may answer "default"
        // for another app's op instead of throwing. Only a seen grant (fail) or the Device Owner's
        // restriction (pass) is judged; otherwise "not measured" with this reason.
        if (allowed.isEmpty()) return UnknownSourcesFacts(restricted, null, "no app was seen with the \"Install unknown apps\" grant, but Android may hide other apps' grants from the agent")
        return UnknownSourcesFacts(restricted, allowed, null)
    }
}
