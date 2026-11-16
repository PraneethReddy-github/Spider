plugins {
    id("org.springframework.boot") version "3.3.0"
    kotlin("jvm") version "2.0.0"
    kotlin("plugin.spring") version "2.0.0"
}

dependencies {
    implementation("org.springframework.boot:spring-boot-starter-web")
    implementation("com.fasterxml.jackson.module:jackson-module-kotlin")
    testImplementation("org.springframework.boot:spring-boot-starter-test")
}
