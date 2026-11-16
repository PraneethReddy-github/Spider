package com.example.greet.service

import com.example.greet.model.Greeting
import com.example.greet.repo.GreetingRepository
import org.springframework.stereotype.Service

@Service
class GreetingService(private val repository: GreetingRepository) : AuditedService() {
    private val fallback = Greeting(0, "hello")

    fun all(): List<Greeting> {
        audit("all")
        return repository.findAll()
    }

    fun find(id: Long): Greeting = repository.byId(id) ?: fallback

    fun add(greeting: Greeting): Greeting {
        val stored = repository.save(greeting)
        return stored
    }
}
