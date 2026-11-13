import { Controller, Get, Param } from '@nestjs/common';
import { UsersService } from './users.service';

@Controller({ path: 'users' })
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  list() { return this.users.findAll(); }

  @Get(':id')
  one(@Param('id') id: string) { return this.users.findOne(id); }
}
