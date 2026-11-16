package com.example.petshop.service;

import static com.example.petshop.util.Strings.normalize;

public abstract class AuditedService {
    protected void audit(String action) {
        String clean = normalize(action);
        System.out.println(clean);
    }
}
