// Define the Kotlin version that aligns with AGP 8.x (usually 1.9.22)
val kotlin_version = "1.9.22" 

plugins {
    id("com.android.application")
    id("kotlin-android")
    id("dev.flutter.flutter-gradle-plugin")
}

android {
    namespace = "com.example.legacy_mobile"
    // Compile SDK is correctly set to 35
    compileSdk = 36 
    ndkVersion = flutter.ndkVersion

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_21
        targetCompatibility = JavaVersion.VERSION_21
    }

    // Use Java toolchain to request Java 21 for compilation where supported
    java {
        toolchain {
            languageVersion.set(JavaLanguageVersion.of(21))
        }
    }

    kotlinOptions {
        // Ensure this matches the Java version
        jvmTarget = "21"
    }

    defaultConfig {
        applicationId = "com.example.legacy_mobile"
        // Ensure minSdk is at least 21 for modern libraries
        minSdk = flutter.minSdkVersion.coerceAtLeast(21)
        // Target SDK must match compile SDK
        targetSdk = 36 
        versionCode = flutter.versionCode
        versionName = flutter.versionName

        resValue("string", "google_speech_key", "google_speech.json")
    }

    buildTypes {
        release {
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    packaging {
        resources {
            // Excludes non-Android native libraries
            excludes += listOf("lib/linux/**", "lib/macos/**", "lib/ios/**", "lib/web/**")
        }
    }
}

flutter {
    source = "../.."
}

dependencies {
    // CRITICAL: Explicitly ensure the Kotlin standard library uses the specified modern version
    implementation("org.jetbrains.kotlin:kotlin-stdlib:$kotlin_version")

    // Add any other app dependencies here if needed, but this Kotlin fix is the priority.
}