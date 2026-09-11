/* InternalBeyond · Android thin client (app module)

   ── Dependency policy (Phase 1: "如果增加第三方依赖，先说明理由") ──────
   Non-AndroidX third-party runtime dependencies: exactly ONE.

   · okhttp3          — SSE needs a request whose CONNECT/handshake has a timeout
                        while its READ does not, plus a way to cancel a blocked
                        read from another thread when the app leaves the
                        foreground. HttpURLConnection cannot express that without
                        global system properties, and its disconnect() semantics
                        during a blocked read are not dependable across Android
                        versions. Apache-2.0; pulls in okio + kotlin-stdlib only.
   · androidx.* (compose, activity, lifecycle, core) — required for Compose.
   · org.json         — SHIPS IN THE ANDROID PLATFORM (android.jar), so it costs
                        zero APK bytes. Chosen over kotlinx.serialization / Moshi
                        / Gson because the protocol demands hand-written strict
                        validation (v must be an integer, `v:true` must be
                        rejected, unknown fields must not propagate), which is
                        exactly what generated adapters hide. The same parser
                        source is used by the JVM tests (test-only org.json).

   Deliberately NOT used:
   · Room / KSP          — the cache is 6 small tables with hand-written upsert
                           AND delete semantics; Room would add an annotation
                           processor and 4 artifacts to the build for no
                           correctness we do not already have. See CacheSchema.
   · navigation-compose  — 4 screens and one *specific* back ladder (Phase 29).
                           A 40-line pure-Kotlin stack is smaller AND testable on
                           the JVM without instrumentation.
   · security-crypto     — deprecated. Token storage is Keystore AES/GCM direct.
*/
plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "com.internalbeyond.mobile"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.internalbeyond.mobile"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "1.0.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    buildTypes {
        debug {
            // The M1-C deliverable (Phase 37: assembleDebug).
            isMinifyEnabled = false
            // Debug-only cleartext policy for the trusted-LAN Home Node.
            // See android/app/src/debug/res/xml/network_security_config.xml.
        }
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            // Release posture: cleartext denied except loopback/emulator/mDNS.
            // See android/app/src/main/res/xml/network_security_config.xml.
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    packaging {
        resources.excludes += setOf("/META-INF/{AL2.0,LGPL2.1}")
    }

    testOptions {
        unitTests.isReturnDefaultValues = true
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2024.10.01")
    implementation(composeBom)

    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.7")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.7")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-graphics")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")

    implementation("com.squareup.okhttp3:okhttp:4.12.0")

    debugImplementation("androidx.compose.ui:ui-tooling")

    testImplementation("junit:junit:4.13.2")
    // Test-only HTTP server. Chosen over com.sun.net.httpserver (not on the Android
    // unit-test classpath) and over a hand-rolled socket server, because the tests
    // need scripted responses, scripted throttling and scripted disconnects — which
    // is exactly its Dispatcher/SocketPolicy API. Never part of the APK.
    testImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")
    // The JVM does not ship org.json; this only shadows the android.jar stub so
    // that production parsers can be unit-tested. Not part of the APK.
    testImplementation("org.json:json:20240303")
    // Lets the *real* SQL of the cache layer run in JVM tests through the same
    // SqlDatabase abstraction the Android build uses (test-only, not in the APK).
    testImplementation("org.xerial:sqlite-jdbc:3.46.1.3")
    // coroutines-core arrives transitively (1.7.3 via lifecycle) and is intentionally
    // not pinned again here: a second version would only create a conflict to debug.
}
