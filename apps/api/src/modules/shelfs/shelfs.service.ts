import { Elysia, status } from "elysia";
import { fetchDevices } from "../../utils";

// Read-only view over the external IoT devices API. The service holds no state:
// every call refetches the live device list and maps it onto Shelf shape (see
// fetchDevices in ../../utils/shelfs). No cache on purpose — the web app fetches
// the layout once on load, so a fresh call per request is cheap. A fetch failure
// rejects; the plugin's onError turns it into a 502. seed.json is no longer read
// (kept only as a shape reference for the mapping).

class ShelfsService {
  async list() {
    return fetchDevices();
  }

  async findById(id: string) {
    const shelf = (await fetchDevices()).find((s) => s.id === id);
    if (!shelf) throw status(404, "Shelf not found");
    return shelf;
  }

  // resolve a scanned sku to its shelf. The users route uses this to turn a
  // scanQR sku into a walk target. The IoT feed currently returns the same
  // product sku for every device, so this resolves to the first match (the 1:1
  // guarantee no longer holds); an unknown sku is a 404 like findById.
  async findBySku(sku: string) {
    const shelf = (await fetchDevices()).find((s) => s.sku === sku);
    if (!shelf) throw status(404, `SKU ${sku} not found`);
    return shelf;
  }
}

export const shelfsService = new Elysia({ name: "shelfs.service" }).decorate(
  "shelfsService",
  new ShelfsService(),
);
