package com.example.petshop.web;

import com.example.petshop.model.*;
import com.example.petshop.service.OwnerService;
import java.util.List;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/owners")
public class OwnerController {
    private final OwnerService owners;

    public OwnerController(OwnerService owners) {
        this.owners = owners;
    }

    @GetMapping
    public List<Owner> list() {
        return owners.findAll();
    }

    @GetMapping("/{id}")
    public Owner show(@PathVariable int id) {
        return this.owners.find(id);
    }

    @PostMapping(path = "/")
    public Owner create(@RequestBody Owner owner) {
        Owner saved = owners.save(owner);
        saved.rename(owner.getName());
        return saved;
    }

    @RequestMapping(value = "/search", method = RequestMethod.GET)
    public List<Owner> search(@RequestParam String q) {
        return owners.findAll();
    }

    @DeleteMapping("/{id}")
    public void remove(@PathVariable int id) {
        owners.find(id);
    }
}
