import { text, timestamp, foreignKey, integer, doublePrecision, uuid } from "drizzle-orm/pg-core";
import { authSchema } from "./_schema";
import { inventories } from "./inventories";
import { units } from "./units";
import { orders } from "./orders";

export const orderItems = authSchema.table("order_items", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	orderId: uuid("order_id").notNull(),
	inventoryId: uuid("inventory_id"),
	name: text().notNull(),
	price: doublePrecision().notNull(),
	amount: integer().notNull(),
	weightPerPiece: doublePrecision("weight_per_piece").notNull(),
	unitId: uuid("unit_id"),
	imageUrl: text("image_url"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	deletedAt: timestamp("deleted_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	foreignKey({
			columns: [table.orderId],
			foreignColumns: [orders.id],
			name: "order_items_order_id_orders_id_fk"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.inventoryId],
			foreignColumns: [inventories.id],
			name: "order_items_inventory_id_inventories_id_fk"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.unitId],
			foreignColumns: [units.id],
			name: "order_items_unit_id_units_id_fk"
		}).onDelete("set null"),
]);
