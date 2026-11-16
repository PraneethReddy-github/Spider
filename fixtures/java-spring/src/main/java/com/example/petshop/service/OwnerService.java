package com.example.petshop.service;

import com.example.petshop.model.Owner;
import java.util.List;

public interface OwnerService {
    List<Owner> findAll();

    Owner find(int id);

    Owner save(Owner owner);
}
