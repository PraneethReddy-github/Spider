import Router from '@koa/router';

const users = new Router({ prefix: '/users' });
users.get('user-list', '/', listUsers);
users.get('/:id', getUser);

export function listUsers(ctx: any) { ctx.body = []; }
export function getUser(ctx: any) { ctx.body = {}; }
export default users;
