package com.example.petshop.model;

import com.example.petshop.util.Strings;

public class Owner {
    private int id;
    private String name;

    public Owner(int id, String name) {
        this.id = id;
        this.name = Strings.normalize(name);
    }

    public int getId() {
        return id;
    }

    public String getName() {
        return name;
    }

    public void rename(String name) {
        this.name = name;
    }
}
