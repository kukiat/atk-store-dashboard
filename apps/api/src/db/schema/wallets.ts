import { uniqueIndex, text, timestamp, foreignKey, integer, uuid } from "drizzle-orm/pg-core";
import { authSchema } from "./_schema";
import { walletStatusEnum } from "./_enums";
import { users } from "./users";

export const wallets = authSchema.table("wallets", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	userId: integer("user_id").notNull(),
	currency: text().default('THB').notNull(),
	balanceAvailableMinor: integer("balance_available_minor").default(0).notNull(),
	balancePendingMinor: integer("balance_pending_minor").default(0).notNull(),
	status: walletStatusEnum().default('active').notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	deletedAt: timestamp("deleted_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	uniqueIndex("wallets_user_id_unique").using("btree", table.userId.asc().nullsLast().op("int4_ops")),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "wallets_user_id_users_id_fk"
		}).onDelete("cascade"),
]);
