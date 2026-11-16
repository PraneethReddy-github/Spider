import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('sessions')
export class Session {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  token!: string;
}
