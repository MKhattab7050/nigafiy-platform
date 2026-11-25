import java.util.Properties

// The Nigafiy Android agent (Device Policy Controller). Framework APIs only: no AndroidX, no Google
// Play services, no Firebase. Kotlin is compiled by AGP's built-in Kotlin support.
plugins {
    id("com.android.application")
}

// Release signing: a key generated on this PC by scripts/android/keystore.mjs into .data/android
// (never committed). Without it the release build is left unsigned and the script says so.
val keystoreProps = Properties().apply {
    val f = rootProject.file("../../.data/android/keystore.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}

android {
    namespace = "com.nigafiy.agent"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.nigafiy.agent"
        minSdk = 26
        targetSdk = 36
        versionCode = 3
        versionName = "1.0.2"
    }

    signingConfigs {
        if (keystoreProps.getProperty("storeFile") != null) {
            create("release") {
                storeFile = rootProject.file("../../.data/android/" + keystoreProps.getProperty("storeFile"))
                storePassword = keystoreProps.getProperty("storePassword")
                keyAlias = keystoreProps.getProperty("keyAlias")
                keyPassword = keystoreProps.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.findByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    lint {
        // Lint would download its own checks; the build stays offline-friendly.
        checkReleaseBuilds = false
    }
}

kotlin {
    jvmToolchain(17)
}

dependencies {
    implementation(project(":core"))
    // In-app QR scanning through Google Play services: no camera permission, the image never reaches the app.
    implementation("com.google.android.gms:play-services-code-scanner:16.1.0")
}
