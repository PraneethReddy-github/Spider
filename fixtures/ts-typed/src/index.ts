import { UserService, audit } from './service';
import { makeRepo } from './repo';

const svc = new UserService(makeRepo());
svc.rename('1', 'a').then(() => audit(makeRepo()));
