import { Elysia, t } from "elysia";
import { envelope } from "../../envelope";

const CrowdEntity = t.Object({
  target: t.Integer(),
  max: t.Integer(),
});

export const crowdModel = new Elysia({ name: "crowd.model" }).model({
  "crowd.entity": CrowdEntity,
  // Backdoor sends the absolute desired value; the service clamps to [0, max]
  "crowd.set": t.Object({
    target: t.Integer({ minimum: 0 }),
  }),
  // success-response envelope (see ../../envelope)
  "crowd.res.entity": envelope(CrowdEntity),
});
