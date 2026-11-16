import axios from 'axios';

const ORDERS_URL = import.meta.env.VITE_ORDERS_URL;
const catalog = axios.create({ baseURL: 'http://localhost:8000' });

export async function listItems() {
  return (await catalog.get('/items')).data;
}

export async function getItem(id: string) {
  return (await catalog.get(`/items/${id}`)).data;
}

export async function createOrder(itemId: string) {
  return fetch(`${ORDERS_URL}/orders`, { method: 'POST', body: JSON.stringify({ itemId }) });
}

export async function getOrder(id: string) {
  return fetch(`http://localhost:8080/orders/${id}`);
}

export async function cancelOrder(id: string) {
  // served through the dev proxy under /api
  return fetch('/api/orders/' + id, { method: 'DELETE' });
}

export async function health() {
  return fetch('/health');
}

export async function stars() {
  return fetch('https://api.github.com/repos/acme/shop');
}
