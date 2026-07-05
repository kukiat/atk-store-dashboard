import { text, timestamp, foreignKey, integer, doublePrecision, uuid, boolean } from "drizzle-orm/pg-core";
import { authSchema } from "./_schema";
import { shelfs } from "./shelfs";
import { units } from "./units";

export const inventories = authSchema.table("inventories", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	shelfId: uuid("shelf_id").notNull(),
	name: text().notNull(),
	description: text(),
	price: doublePrecision().notNull(),
	amount: integer().default(0).notNull(),
	weightPerPiece: doublePrecision("weight_per_piece").notNull(),
	unitId: uuid("unit_id").notNull(),
	isActive: boolean("is_active").default(true).notNull(),
	imageUrl: text("image_url"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	deletedAt: timestamp("deleted_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	foreignKey({
			columns: [table.shelfId],
			foreignColumns: [shelfs.id],
			name: "inventories_shelf_id_shelfs_id_fk"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.unitId],
			foreignColumns: [units.id],
			name: "inventories_unit_id_units_id_fk"
		}).onDelete("restrict"),
]);
