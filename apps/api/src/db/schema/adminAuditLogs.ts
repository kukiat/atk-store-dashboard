import { serial, text, timestamp, foreignKey, integer, jsonb } from "drizzle-orm/pg-core";
import { authSchema } from "./_schema";
import { users } from "./users";

export const adminAuditLogs = authSchema.table("admin_audit_logs", {
	id: serial().primaryKey().notNull(),
	actorUserId: integer("actor_user_id"),
	targetUserId: integer("target_user_id"),
	action: text().notNull(),
	metadata: jsonb(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.actorUserId],
			foreignColumns: [users.id],
			name: "admin_audit_logs_actor_user_id_users_id_fk"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.targetUserId],
			foreignColumns: [users.id],
			name: "admin_audit_logs_target_user_id_users_id_fk"
		}).onDelete("set null"),
]);
