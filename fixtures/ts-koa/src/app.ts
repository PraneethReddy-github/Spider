import Koa from 'koa';
import Router from '@koa/router';
import users from './routes/users';

const app = new Koa();
const api = new Router();
api.use('/api', users.routes(), users.allowedMethods());
api.get('/health', health);
app.use(api.routes());

function health(ctx: any) { ctx.body = 'ok'; }
