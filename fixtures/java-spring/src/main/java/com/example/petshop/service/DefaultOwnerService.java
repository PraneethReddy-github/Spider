package com.example.petshop.service;

import com.example.petshop.model.Owner;
import com.example.petshop.repo.OwnerRepository;
import java.util.List;
import org.springframework.stereotype.Service;

@Service
public class DefaultOwnerService extends AuditedService implements OwnerService {
    private final OwnerRepository repository = new OwnerRepository();

    @Override
    public List<Owner> findAll() {
        audit("findAll");
        return repository.all();
    }

    @Override
    public Owner find(int id) {
        return repository.byId(id);
    }

    @Override
    public Owner save(Owner owner) {
        List<Owner> existing = repository.all();
        existing.add(owner);
        return repository.store(owner);
    }
}
