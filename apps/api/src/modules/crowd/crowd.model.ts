import { Elysia, t } from "elysia";

export const crowdModel = new Elysia({ name: "crowd.model" }).model({
  "crowd.entity": t.Object({
    target: t.Integer(),
    max: t.Integer(),
  }),
  // Backdoor sends the absolute desired value; the service clamps to [0, max]
  "crowd.set": t.Object({
    target: t.Integer({ minimum: 0 }),
  }),
});
