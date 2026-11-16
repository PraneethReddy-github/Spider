import { PrismaClient } from '@prisma/client';
import { Queue, Worker } from 'bullmq';
import { Kafka } from 'kafkajs';
import type { Repository } from 'typeorm';
import type { Session } from './entities';

const prisma = new PrismaClient();
const kafka = new Kafka({ clientId: 'api', brokers: ['kafka:9092'] });
const producer = kafka.producer();
const consumer = kafka.consumer({ groupId: 'api' });
const emailQueue = new Queue('emails');

export async function listUsers() {
  return prisma.user.findMany();
}

export async function createPost(title: string) {
  const post = await prisma.post.create({ data: { title } });
  await producer.send({ topic: 'post-events', messages: [{ value: title }] });
  return post;
}

export async function audit(db: { query(sql: string, args: unknown[]): Promise<void> }, who: string) {
  await db.query('INSERT INTO audit_log (who) VALUES ($1)', [who]);
}

export async function welcome(email: string) {
  await emailQueue.add('welcome', { email });
}

export async function listen() {
  await consumer.subscribe({ topic: 'post-events' });
}

new Worker('emails', async () => {});

export class SessionService {
  constructor(private readonly sessionRepository: Repository<Session>) {}

  touch(s: Session) {
    return this.sessionRepository.save(s);
  }

  active() {
    return this.sessionRepository.find();
  }
}
