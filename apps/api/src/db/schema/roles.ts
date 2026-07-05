import { unique, serial, text, timestamp } from "drizzle-orm/pg-core";
import { authSchema } from "./_schema";

export const roles = authSchema.table("roles", {
	id: serial().primaryKey().notNull(),
	code: text().notNull(),
	name: text().notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	unique("roles_code_unique").on(table.code),
]);
