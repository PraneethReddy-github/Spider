import { Order, type User, type UserId } from './models';
import { logged } from './decorators';

export class UserRepo {
  @logged
  async find(id: UserId): Promise<User | undefined> {
    return undefined;
  }
  async latestOrder(user: User): Promise<Order> {
    return new Order();
  }
  save(user: User): void {}
}

export function makeRepo(): UserRepo {
  return new UserRepo();
}
