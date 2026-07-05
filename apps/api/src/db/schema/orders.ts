import { text, timestamp, foreignKey, integer, doublePrecision, uuid } from "drizzle-orm/pg-core";
import { authSchema } from "./_schema";
import { orderStatusEnum, paymentStatusEnum } from "./_enums";
import { clientVisits } from "./clientVisits";

export const orders = authSchema.table("orders", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	clientVisitId: integer("client_visit_id").notNull(),
	status: orderStatusEnum().default('paid').notNull(),
	paymentStatus: paymentStatusEnum("payment_status").default('paid').notNull(),
	totalPrice: doublePrecision("total_price").default(0).notNull(),
	paymentReference: text("payment_reference"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	deletedAt: timestamp("deleted_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	foreignKey({
			columns: [table.clientVisitId],
			foreignColumns: [clientVisits.id],
			name: "orders_client_visit_id_client_visits_id_fk"
		}).onDelete("cascade"),
]);
