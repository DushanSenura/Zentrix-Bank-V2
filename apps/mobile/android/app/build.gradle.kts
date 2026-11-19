import java.util.Properties

val keystoreProps = Properties().apply {
    val f = rootProject.file("key.properties")   // git-ignored; see docs/deployment/android-release.md
    if (f.exists()) f.inputStream().use { load(it) }
}
val haveReleaseKey = keystoreProps.getProperty("storeFile") != null

plugins {
    id("com.android.application")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

android {
    buildFeatures { buildConfig = true }
    namespace = "lk.zentrix.zentrix_bank"
    compileSdk = flutter.compileSdkVersion
    ndkVersion = flutter.ndkVersion

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    defaultConfig {
        applicationId = "lk.zentrix.zentrix_bank"
        // You can update the following values to match your application needs.
        // For more information, see: https://flutter.dev/to/review-gradle-config.
        minSdk = flutter.minSdkVersion
        targetSdk = flutter.targetSdkVersion
        versionCode = flutter.versionCode
        versionName = flutter.versionName
    }

    signingConfigs {
        if (haveReleaseKey) {
            create("release") {
                storeFile = rootProject.file(keystoreProps.getProperty("storeFile"))
                storePassword = keystoreProps.getProperty("storePassword")
                keyAlias = keystoreProps.getProperty("keyAlias")
                keyPassword = keystoreProps.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            // Release builds are signed with YOUR release key (android/key.properties). They are never silently signed with the
            // public debug key: without a key the build fails, unless you explicitly pass -Pzentrix.allowDebugSigning=true
            // to make a throwaway artifact for testing a build on your own device (never distribute it).
            signingConfig = when {
                haveReleaseKey -> signingConfigs.getByName("release")
                project.hasProperty("zentrix.allowDebugSigning") -> signingConfigs.getByName("debug")
                else -> throw GradleException("No release signing key. Create android/key.properties (see docs/deployment/android-release.md), or pass -Pzentrix.allowDebugSigning=true for a test-only build.")
            }
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }
}

kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
    }
}

flutter {
    source = "../.."
}
