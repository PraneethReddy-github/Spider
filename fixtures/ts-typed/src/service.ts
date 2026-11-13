import { UserRepo, makeRepo } from './repo';
import type { User } from './models';

export class UserService {
  private cache: Map<string, User> = new Map();
  constructor(private readonly repo: UserRepo) {}

  async rename(id: string, name: string) {
    const user = await this.repo.find(id);
    const order = await this.repo.latestOrder(user as User);
    order.total();
    this.repo.save({ id, name });
  }
}

export async function audit(repo: UserRepo) {
  await repo.find('1');
  const r = makeRepo();
  r.save({ id: '1', name: 'x' });
}
