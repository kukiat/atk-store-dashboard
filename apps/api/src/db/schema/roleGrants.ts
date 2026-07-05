import { uniqueIndex, serial, text, timestamp, foreignKey, integer } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { authSchema } from "./_schema";
import { roleGrantStatusEnum } from "./_enums";
import { users } from "./users";
import { roles } from "./roles";

export const roleGrants = authSchema.table("role_grants", {
	id: serial().primaryKey().notNull(),
	email: text().notNull(),
	roleId: integer("role_id").notNull(),
	status: roleGrantStatusEnum().default('pending').notNull(),
	invitedByUserId: integer("invited_by_user_id"),
	acceptedByUserId: integer("accepted_by_user_id"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	acceptedAt: timestamp("accepted_at", { withTimezone: true, mode: 'string' }),
	revokedAt: timestamp("revoked_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	uniqueIndex("role_grants_email_role_pending_unique").using("btree", table.email.asc().nullsLast().op("int4_ops"), table.roleId.asc().nullsLast().op("int4_ops")).where(sql`(status = 'pending'::auth.role_grant_status)`),
	foreignKey({
			columns: [table.roleId],
			foreignColumns: [roles.id],
			name: "role_grants_role_id_roles_id_fk"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.invitedByUserId],
			foreignColumns: [users.id],
			name: "role_grants_invited_by_user_id_users_id_fk"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.acceptedByUserId],
			foreignColumns: [users.id],
			name: "role_grants_accepted_by_user_id_users_id_fk"
		}).onDelete("set null"),
]);
