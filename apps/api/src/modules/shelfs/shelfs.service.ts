import { Elysia, status } from "elysia";
import seed from "./seed.json";

// In-memory stand-in for the future external shelfs API — no DB on purpose.
// This module serves the mock store layout read-only; seed.json is the whole
// truth (a copy of the web app's public/mock/shelves.json). Nothing mutates
// here, so there is no store Map / SSE / event hub like the users module.
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
  type: "wall" | "gondola" | "checkout";
  x: number;
  z: number;
  rotation: number;
  length: number;
  online: boolean;
  items: ShelfItem[];
};

class ShelfsService {
  private readonly shelves = seed.shelves as Shelf[];

  list() {
    return this.shelves;
  }

  findById(id: number) {
    const shelf = this.shelves.find((s) => s.id === id);
    if (!shelf) throw status(404, "Shelf not found");
    return shelf;
  }
}

export const shelfsService = new Elysia({ name: "shelfs.service" }).decorate(
  "shelfsService",
  new ShelfsService(),
);
