import { Billing, Mailer } from './services';
import * as models from './models';

const billing = new Billing();
const account = models.Account.open('me');
billing.charge(account);
const mailer = new Mailer();
mailer.deliver('me');
