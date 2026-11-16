package com.acme.shop;

import jakarta.persistence.Entity;
import java.util.List;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.jdbc.core.JdbcTemplate;

@Entity
class Owner {
    Integer id;
}

interface OwnerRepository extends JpaRepository<Owner, Integer> {}

class OwnerService {
    private final OwnerRepository owners;
    private final JdbcTemplate jdbc;

    OwnerService(OwnerRepository owners, JdbcTemplate jdbc) {
        this.owners = owners;
        this.jdbc = jdbc;
    }

    List<Owner> all() {
        return owners.findAll();
    }

    void add(Owner o) {
        owners.save(o);
    }

    int legacyCount() {
        return jdbc.queryForObject("SELECT count(*) FROM owners", Integer.class);
    }
}
