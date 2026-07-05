import { text, timestamp, foreignKey, uuid } from "drizzle-orm/pg-core";
import { authSchema } from "./_schema";
import { groups } from "./groups";

export const shelfs = authSchema.table("shelfs", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	groupId: uuid("group_id"),
	name: text().notNull(),
	imageUrl: text("image_url"),
	sensorId: text("sensor_id"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	deletedAt: timestamp("deleted_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	foreignKey({
			columns: [table.groupId],
			foreignColumns: [groups.id],
			name: "shelfs_group_id_groups_id_fk"
		}).onDelete("set null"),
]);
