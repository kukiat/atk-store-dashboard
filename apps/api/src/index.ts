import { Elysia } from "elysia";
import { cors } from "@elysiajs/cors";
import { swagger } from "@elysiajs/swagger";
import { API_VERSION } from "@atk-store-dashboard/shared";
import { groupsPlugin } from "./modules/groups";
import { shelfsPlugin } from "./modules/shelfs";
import { usersPlugin } from "./modules/users";
import { crowdPlugin } from "./modules/crowd";
import { sessionsPlugin } from "./modules/sessions";
import { startMqtt } from "./mqtt";

const port = Number(process.env.PORT ?? 3004);

const app = new Elysia()
  .use(cors({ origin: true }))
  .use(
    swagger({
      path: "/swagger",
      documentation: {
        info: { title: "atk-store-dashboard API", version: API_VERSION },
      },
    }),
  )
  .get("/health-check", () => ({
    status: "ok" as const,
    version: API_VERSION,
    timestamp: new Date().toISOString(),
  }))
  .use(groupsPlugin)
  .use(shelfsPlugin)
  .use(usersPlugin)
  .use(crowdPlugin)
  .use(sessionsPlugin)
  .listen(port);

// open the loadcell MQTT feed once the HTTP server is up
startMqtt();

console.log(`api listening on http://localhost:${port}`);
console.log(`swagger docs at http://localhost:${port}/swagger`);

export type App = typeof app;
