package com.example.greet.model

data class Greeting(val id: Long, val text: String) {
    fun shout(): Greeting = copy(text = text.uppercase())
}
