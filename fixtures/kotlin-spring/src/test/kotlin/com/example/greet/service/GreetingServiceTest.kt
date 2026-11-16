package com.example.greet.service

import com.example.greet.repo.GreetingRepository
import org.junit.jupiter.api.Test

class GreetingServiceTest {
    @Test
    fun findsAll() {
        val service = GreetingService(GreetingRepository())
        service.all()
    }
}
