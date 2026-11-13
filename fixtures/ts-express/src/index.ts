import express from 'express';
import { registerUserRoutes } from './routes/users';
import { OrderController } from './routes/orders';
import { connect } from './services/db';

const app = express();
registerUserRoutes(app);
const orders = new OrderController();
app.get('/orders/:id', (req, res) => orders.get(req, res));
app.post('/orders', orders.create);
connect().then(() => app.listen(3000));
