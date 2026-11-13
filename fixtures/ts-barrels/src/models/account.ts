export class Account {
  static open(owner: string): Account { return new Account(); }
  close(): void {}
}
