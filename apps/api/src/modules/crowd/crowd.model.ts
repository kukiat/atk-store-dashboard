import { Elysia, t } from "elysia";
import { envelope } from "../../envelope";

const CrowdEntity = t.Object({
  target: t.Integer(),
  max: t.Integer(),
  costume: t.Boolean(),
});

export const crowdModel = new Elysia({ name: "crowd.model" }).model({
  "crowd.entity": CrowdEntity,
  // Backdoor sends the absolute desired value; the service clamps to [0, max].
  // Both fields are optional — the head-count stepper and the Costume Mode
  // switch PATCH the same route and each only sends its own field.
  "crowd.set": t.Object({
    target: t.Optional(t.Integer({ minimum: 0 })),
    costume: t.Optional(t.Boolean()),
  }),
  // success-response envelope (see ../../envelope)
  "crowd.res.entity": envelope(CrowdEntity),
});
