// Central domain types for the shelfs module. Plain TypeScript shapes for the
// mock store layout; the Elysia/TypeBox schemas live in
// ../modules/shelfs/shelfs.model.ts.
export type ShelfItem = {
  id: string;
  name: string;
  color: string;
  capacity: number;
  qty: number;
  reorder: number;
};
export type Shelf = {
  id: number;
  name: string;
  // unique zone code (BEV/SNK/…) — the users API resolves a scanQR sku to its
  // shelf 1:1 via findBySku; one sku per shelf
  sku: string;
  type: "wall" | "gondola" | "checkout";
  x: number;
  z: number;
  rotation: number;
  length: number;
  online: boolean;
  items: ShelfItem[];
};
