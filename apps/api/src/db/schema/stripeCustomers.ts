import { uniqueIndex, text, timestamp, foreignKey, integer, uuid, boolean } from "drizzle-orm/pg-core";
import { authSchema } from "./_schema";
import { users } from "./users";

export const stripeCustomers = authSchema.table("stripe_customers", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	userId: integer("user_id").notNull(),
	stripeCustomerId: text("stripe_customer_id").notNull(),
	emailSnapshot: text("email_snapshot").notNull(),
	livemode: boolean().default(false).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	deletedAt: timestamp("deleted_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	uniqueIndex("stripe_customers_provider_id_livemode_unique").using("btree", table.stripeCustomerId.asc().nullsLast().op("text_ops"), table.livemode.asc().nullsLast().op("text_ops")),
	uniqueIndex("stripe_customers_user_livemode_unique").using("btree", table.userId.asc().nullsLast().op("int4_ops"), table.livemode.asc().nullsLast().op("int4_ops")),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "stripe_customers_user_id_users_id_fk"
		}).onDelete("cascade"),
]);
