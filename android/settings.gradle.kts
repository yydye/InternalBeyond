/* InternalBeyond · Android thin client
   M1-C · standalone Gradle build. Deliberately NOT part of any JS toolchain:
   the web runtime (assets/, services/, bridge/) never sees this directory.

   ── Repository order ────────────────────────────────────────────────────────
   The public mirrors are listed FIRST because on the networks this project is
   developed on, dl.google.com is unreachable and repo1.maven.org runs at roughly
   100 KB/s, which makes a clean build take hours. These mirrors serve the same
   artifacts (Aliyun mirrors maven.google.com and Maven Central byte for byte);
   if a mirror is unavailable, resolution falls through to google()/mavenCentral()
   below, so the build is not dependent on them. */
pluginManagement {
    repositories {
        maven("https://maven.aliyun.com/repository/gradle-plugin")
        maven("https://maven.aliyun.com/repository/google")
        maven("https://maven.aliyun.com/repository/public")
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        maven("https://maven.aliyun.com/repository/google")
        maven("https://maven.aliyun.com/repository/public")
        google()
        mavenCentral()
    }
}

rootProject.name = "InternalBeyond"
include(":app")
