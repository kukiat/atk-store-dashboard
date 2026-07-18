import { Elysia, t } from "elysia";
import { envelope } from "../../envelope";

const Gender = t.Union([t.Literal("male"), t.Literal("female")]);
const Status = t.Union([
  t.Literal("outside"),
  t.Literal("waiting"),
  t.Literal("inside"),
  t.Literal("scanning"),
  t.Literal("browsing"),
  t.Literal("paying"),
]);
const AuthMethod = t.Union([
  t.Literal("google"),
  t.Literal("outlook"),
  t.Literal("facebook"),
]);
const Result = t.Union([t.Literal("pass"), t.Literal("fail")]);
const InspectResult = t.Union([t.Literal("keep"), t.Literal("return")]);

const UserEntity = t.Object({
  id: t.Integer(),
  name: t.String(),
  gender: Gender,
  status: Status,
  // shelf session (scanning/browsing only) — which shelf, and when the API's
  // own 30s browse timer will auto-close the session (epoch ms); null otherwise
  shelf_id: t.Nullable(t.Integer()),
  browse_until: t.Nullable(t.Number()),
  // display-only profile fields — required on the entity, defaulted on create
  email: t.String({ format: "email" }),
  avatar_url: t.String(), // may be "" → UI falls back to initials chip
  auth_method: AuthMethod,
});

export const usersModel = new Elysia({ name: "users.model" }).model({
  // path ids arrive as strings — t.Numeric coerces before validation
  "users.params": t.Object({ id: t.Numeric() }),
  // profile fields optional on create — service fills defaults (email from id,
  // avatar "", auth "google") so a bare {name,gender} POST still works
  "users.create": t.Object({
    name: t.String({ minLength: 1 }),
    gender: Gender,
    email: t.Optional(t.String({ format: "email" })),
    avatar_url: t.Optional(t.String()),
    auth_method: t.Optional(AuthMethod),
  }),
  // PATCH — every field optional (status moves only via enter/verify/leave/pay)
  "users.update": t.Object({
    name: t.Optional(t.String({ minLength: 1 })),
    gender: t.Optional(Gender),
    email: t.Optional(t.String({ format: "email" })),
    avatar_url: t.Optional(t.String()),
    auth_method: t.Optional(AuthMethod),
  }),
  // single body for POST /:id/status — a discriminated union on `action`.
  // enter/leave/walkAway carry no data; verify/pay/scanQR require a pass/fail
  // result, walkToShelf a shelfId, inspectItem a keep/return result — all
  // nested under `payload`. A wrong combo (verify without a result, etc.) is
  // rejected here at validation (422) before the service switch ever runs.
  "users.action": t.Union([
    t.Object({ action: t.Literal("enter") }),
    t.Object({ action: t.Literal("leave") }),
    t.Object({ action: t.Literal("walkAway") }),
    t.Object({
      action: t.Literal("verify"),
      // imageURL is optional and transient — carried through the `verify` SSE
      // event (not stored on the user) so the dashboard can flash the face
      // photo on a pass. Any string (full URL, relative path, or data URI).
      payload: t.Object({ result: Result, imageURL: t.Optional(t.String()) }),
    }),
    t.Object({
      action: t.Literal("pay"),
      payload: t.Object({ result: Result }),
    }),
    t.Object({
      action: t.Literal("scanQR"),
      payload: t.Object({ result: Result }),
    }),
    t.Object({
      action: t.Literal("walkToShelf"),
      payload: t.Object({ shelfId: t.Integer() }),
    }),
    t.Object({
      action: t.Literal("inspectItem"),
      payload: t.Object({ result: InspectResult }),
    }),
  ]),
  "users.entity": UserEntity,
  "users.list": t.Array(UserEntity),
  // success-response envelopes (see ../../envelope). DELETE returns just the id
  // now — `deleted: true` was a third restatement of success (200 + success:
  // true already say it) and `deleted: false` could never occur (a failed
  // delete is a 404).
  "users.res.entity": envelope(UserEntity),
  "users.res.list": envelope(t.Array(UserEntity)),
  "users.res.deleted": envelope(t.Object({ id: t.Integer() })),
});
