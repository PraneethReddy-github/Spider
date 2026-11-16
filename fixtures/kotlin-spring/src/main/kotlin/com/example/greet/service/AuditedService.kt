package com.example.greet.service

import com.example.greet.util.log

abstract class AuditedService {
    protected fun audit(action: String) {
        log("audit: $action")
    }
}
