export interface User { id: string; name: string }
export type UserId = string;
export interface Unused { x: number }
export class Order {
  total(): number { return 0; }
}
