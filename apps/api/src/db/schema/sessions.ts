import { text, timestamp, foreignKey, integer } from "drizzle-orm/pg-core";
import { authSchema } from "./_schema";
import { users } from "./users";

export const sessions = authSchema.table("sessions", {
	id: text().primaryKey().notNull(),
	userId: integer("user_id").notNull(),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "sessions_user_id_users_id_fk"
		}).onDelete("cascade"),
]);
