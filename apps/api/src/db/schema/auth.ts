import { pgSchema, uuid, text, timestamp } from "drizzle-orm/pg-core";

/**
 * The `auth` Postgres schema. Managed externally (database-first);
 * Drizzle only maps these tables for querying — it does not own migrations.
 */
export const authSchema = pgSchema("auth");

export const groups = authSchema.table("groups", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

export type Group = typeof groups.$inferSelect;
export type NewGroup = typeof groups.$inferInsert;
