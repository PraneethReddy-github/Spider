import { BaseController } from './base';
import { query } from '../services/db';
import { formatMoney } from '../utils';

export class OrderController extends BaseController {
  async get(req: any, res: any) {
    const row = await query('select * from orders where id = $1', [req.params.id]);
    this.ok(res, { ...row, total: formatMoney(row.total) });
  }
  create = async (req: any, res: any) => {
    await query('insert into orders values ($1)', [req.body]);
    this.ok(res, {});
  };
}
