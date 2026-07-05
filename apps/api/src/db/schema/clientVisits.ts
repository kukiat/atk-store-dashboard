import { uniqueIndex, serial, timestamp, foreignKey, integer } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { authSchema } from "./_schema";
import { clientVisitStatusEnum } from "./_enums";
import { users } from "./users";

export const clientVisits = authSchema.table("client_visits", {
	id: serial().primaryKey().notNull(),
	userId: integer("user_id").notNull(),
	status: clientVisitStatusEnum().default('inside').notNull(),
	enteredAt: timestamp("entered_at", { withTimezone: true, mode: 'string' }).notNull(),
	exitedAt: timestamp("exited_at", { withTimezone: true, mode: 'string' }),
	entryEventId: integer("entry_event_id"),
	exitEventId: integer("exit_event_id"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex("client_visits_one_open_per_user").using("btree", table.userId.asc().nullsLast().op("int4_ops")).where(sql`(status = 'inside'::auth.client_visit_status)`),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "client_visits_user_id_users_id_fk"
		}).onDelete("cascade"),
]);
