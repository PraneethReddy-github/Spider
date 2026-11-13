import { Injectable } from '@nestjs/common';

@Injectable()
export class UsersService {
  findAll(): string[] { return []; }
  findOne(id: string): string { return id; }
}
