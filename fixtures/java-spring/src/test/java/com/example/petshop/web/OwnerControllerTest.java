package com.example.petshop.web;

import com.example.petshop.service.DefaultOwnerService;
import org.junit.jupiter.api.Test;

class OwnerControllerTest {
    @Test
    void listsOwners() {
        OwnerController controller = new OwnerController(new DefaultOwnerService());
        controller.list();
    }
}
