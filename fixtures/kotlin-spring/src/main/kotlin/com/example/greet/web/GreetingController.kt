package com.example.greet.web

import com.example.greet.model.Greeting
import com.example.greet.service.GreetingService
import org.springframework.web.bind.annotation.*

@RestController
@RequestMapping("/api/greetings")
class GreetingController(private val service: GreetingService) {

    @GetMapping
    fun list(): List<Greeting> = service.all()

    @GetMapping("/{id}")
    fun one(@PathVariable id: Long): Greeting {
        val greeting: Greeting = service.find(id)
        return greeting.shout()
    }

    @PostMapping
    fun create(@RequestBody body: Greeting): Greeting = service.add(body)

    @RequestMapping(value = ["/purge"], method = [RequestMethod.DELETE])
    fun purge() {
        service.all().forEach { it.shout() }
    }
}
