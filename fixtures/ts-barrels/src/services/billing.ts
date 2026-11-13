import { Account } from '../models';

export default class Billing {
  charge(account: Account): void {
    account.close();
  }
}
