import { timestamp, foreignKey, integer, primaryKey } from "drizzle-orm/pg-core";
import { authSchema } from "./_schema";
import { users } from "./users";
import { roles } from "./roles";

export const userRoles = authSchema.table("user_roles", {
	userId: integer("user_id").notNull(),
	roleId: integer("role_id").notNull(),
	assignedByUserId: integer("assigned_by_user_id"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.roleId],
			foreignColumns: [roles.id],
			name: "user_roles_role_id_roles_id_fk"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.assignedByUserId],
			foreignColumns: [users.id],
			name: "user_roles_assigned_by_user_id_users_id_fk"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "user_roles_user_id_users_id_fk"
		}).onDelete("cascade"),
	primaryKey({ columns: [table.userId, table.roleId], name: "user_roles_user_id_role_id_pk"}),
]);
