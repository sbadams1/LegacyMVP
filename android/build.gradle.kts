import org.gradle.api.file.Directory

// --- CRITICAL FIX: Added buildscript block and updated AGP version ---
buildscript {
    repositories {
        google()
        mavenCentral()
    }
    dependencies {
        // THIS IS THE FIX: Set the Android Gradle Plugin (AGP) version to a modern one (8.1.4 or higher)
        // This version supports the new Android resource formats, resolving the 'android:allowNativeHeap not found' error.
        classpath("com.android.tools.build:gradle:8.1.4")
    }
}
// -------------------------------------------------------------------


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

tasks.register<Delete>("clean") {
    delete(rootProject.layout.buildDirectory)
}