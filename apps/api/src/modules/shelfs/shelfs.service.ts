import { Elysia, status } from "elysia";
import seed from "./seed.json";
import type { Shelf } from "../../models";

// In-memory stand-in for the future external shelfs API — no DB on purpose.
// This module serves the mock store layout read-only; seed.json is the whole
// truth (a copy of the web app's public/mock/shelves.json). Nothing mutates
// here, so there is no store Map / SSE / event hub like the users module.
// The Shelf/ShelfItem domain types live in ../../models.

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

  // resolve a scanned sku to its shelf (1:1 — one sku per shelf). The users
  // route uses this to turn a scanQR sku into a walk target; an unknown sku is
  // a 404 like findById. Online/checkout gating stays with the caller.
  findBySku(sku: string) {
    const shelf = this.shelves.find((s) => s.sku === sku);
    if (!shelf) throw status(404, `SKU ${sku} not found`);
    return shelf;
  }
}

export const shelfsService = new Elysia({ name: "shelfs.service" }).decorate(
  "shelfsService",
  new ShelfsService(),
);
