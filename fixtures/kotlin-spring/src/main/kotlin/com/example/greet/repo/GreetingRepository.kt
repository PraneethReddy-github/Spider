package com.example.greet.repo

import com.example.greet.model.Greeting

class GreetingRepository {
    private val rows = mutableMapOf<Long, Greeting>()

    fun findAll(): List<Greeting> = rows.values.toList()

    fun byId(id: Long): Greeting? = rows[id]

    fun save(greeting: Greeting): Greeting {
        rows[greeting.id] = greeting
        return greeting
    }
}
