import { Pool } from 'pg';
let pool: Pool;
export async function connect() { pool = new Pool(); }
export async function query(sql: string, params: unknown[] = []) { return (await pool.query(sql, params)).rows[0]; }
