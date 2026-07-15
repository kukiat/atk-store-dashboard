import { Elysia, t } from "elysia";

const Gender = t.Union([t.Literal("male"), t.Literal("female")]);
const Status = t.Union([
  t.Literal("outside"),
  t.Literal("waiting"),
  t.Literal("inside"),
  t.Literal("paying"),
]);
const AuthMethod = t.Union([
  t.Literal("google"),
  t.Literal("outlook"),
  t.Literal("facebook"),
]);
const Result = t.Union([t.Literal("pass"), t.Literal("fail")]);

const UserEntity = t.Object({
  id: t.Integer(),
  name: t.String(),
  gender: Gender,
  status: Status,
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
  // PATCH — every field optional (status moves only via checkin/verify/checkout)
  "users.update": t.Object({
    name: t.Optional(t.String({ minLength: 1 })),
    gender: t.Optional(Gender),
    email: t.Optional(t.String({ format: "email" })),
    avatar_url: t.Optional(t.String()),
    auth_method: t.Optional(AuthMethod),
  }),
  // single body for POST /:id/status — a discriminated union on `action`.
  // checkin/checkout carry no data; verify/payment require a pass/fail result
  // nested under `payload`. A wrong combo (verify without a result, etc.) is
  // rejected here at validation (422) before the service switch ever runs.
  "users.action": t.Union([
    t.Object({ action: t.Literal("checkin") }),
    t.Object({ action: t.Literal("checkout") }),
    t.Object({
      action: t.Literal("verify"),
      payload: t.Object({ result: Result }),
    }),
    t.Object({
      action: t.Literal("payment"),
      payload: t.Object({ result: Result }),
    }),
  ]),
  "users.entity": UserEntity,
  "users.list": t.Array(UserEntity),
  "users.deleted": t.Object({
    id: t.Integer(),
    deleted: t.Boolean(),
  }),
});
