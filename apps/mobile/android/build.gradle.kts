allprojects {
    repositories {
        google()
        mavenCentral()
    }
}

val newBuildDir: Directory =
    rootProject.layout.buildDirectory
        .dir("../../build")
        .get()
rootProject.layout.buildDirectory.value(newBuildDir)

subprojects {
    val newSubprojectBuildDir: Directory = newBuildDir.dir(project.name)
    project.layout.buildDirectory.value(newSubprojectBuildDir)
}
subprojects {
    project.evaluationDependsOn(":app")
}

// WORKAROUND (re-check when AGP / Kotlin are upgraded): with AGP 9.0.1 + Kotlin 2.3.20 the release-time "lintVital" check crashes
// inside Android Lint itself (NoClassDefFoundError: kotlin LanguageVersionSettings) for every module, ours included, so it is
// skipped. This removes Android Lint's release-blocking checks; `flutter analyze` and the tests still run. See docs/deployment/android-release.md.
subprojects {
    tasks.matching { it.name.startsWith("lintVital") }.configureEach { enabled = false }
}

tasks.register<Delete>("clean") {
    delete(rootProject.layout.buildDirectory)
}
