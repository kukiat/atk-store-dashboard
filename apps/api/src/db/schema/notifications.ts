import { text, timestamp, foreignKey, integer, jsonb, uuid, boolean } from "drizzle-orm/pg-core";
import { authSchema } from "./_schema";
import { notificationRecipientTypeEnum, notificationSeverityEnum } from "./_enums";
import { users } from "./users";
import { clientVisits } from "./clientVisits";

export const notifications = authSchema.table("notifications", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	clientVisitId: integer("client_visit_id"),
	recipientType: notificationRecipientTypeEnum("recipient_type").notNull(),
	userId: integer("user_id"),
	title: text().notNull(),
	message: text().notNull(),
	severity: notificationSeverityEnum().default('info').notNull(),
	isRead: boolean("is_read").default(false).notNull(),
	rawPayload: jsonb("raw_payload"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	deletedAt: timestamp("deleted_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	foreignKey({
			columns: [table.clientVisitId],
			foreignColumns: [clientVisits.id],
			name: "notifications_client_visit_id_client_visits_id_fk"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "notifications_user_id_users_id_fk"
		}).onDelete("set null"),
]);
