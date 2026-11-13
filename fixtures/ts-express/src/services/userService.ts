import { query } from './db';
import { User } from '../models/user';

export class UserService {
  async list(): Promise<User[]> {
    return query('select * from users');
  }
  async find(id: string): Promise<User> {
    return query('select * from users where id = $1', [id]);
  }
}
