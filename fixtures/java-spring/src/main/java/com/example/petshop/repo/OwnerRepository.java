package com.example.petshop.repo;

import com.example.petshop.model.Owner;
import java.util.*;

public class OwnerRepository {
    private final Map<Integer, Owner> rows = new HashMap<>();

    public List<Owner> all() {
        return new ArrayList<>(rows.values());
    }

    public Owner byId(int id) {
        return rows.get(id);
    }

    public Owner store(Owner owner) {
        rows.put(owner.getId(), owner);
        return owner;
    }
}
