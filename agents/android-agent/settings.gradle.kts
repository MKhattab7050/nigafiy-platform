// Nigafiy Android agent. Repositories: Google Maven and Maven Central only (no Gradle Plugin Portal,
// no Play services, no Firebase).
pluginManagement {
    repositories {
        google()
        mavenCentral()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}
rootProject.name = "nigafiy-android-agent"

// :core is plain Kotlin (protocol, compliance, TLS pin, command rules) and is tested on the JVM.
include(":core")
// :app needs the Android SDK (sdk.dir in local.properties or ANDROID_HOME). Without it, only :core
// builds and tests, so the JVM tests run on a machine with a JDK alone.
val sdkDir = providers.environmentVariable("ANDROID_HOME").orNull
    ?: file("local.properties").takeIf { it.exists() }?.readLines()?.firstOrNull { it.startsWith("sdk.dir=") }?.substringAfter("=")
if (sdkDir != null) include(":app")
