import type { Express } from 'express';
import { UserService } from '@services/userService';

export function registerUserRoutes(app: Express) {
  const svc = new UserService();
  app.get('/users', async (req, res) => {
    res.json(await svc.list());
  });
  app.get('/users/:id', getUser);
  async function getUser(req: any, res: any) {
    res.json(await svc.find(req.params.id));
  }
}
