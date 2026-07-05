import { uniqueIndex, text, timestamp, foreignKey, integer, uuid } from "drizzle-orm/pg-core";
import { authSchema } from "./_schema";
import { orderPaymentMethodEnum, paymentStatusEnum } from "./_enums";
import { orders } from "./orders";
import { wallets } from "./wallets";
import { walletLedgerEntries } from "./walletLedgerEntries";

export const orderPayments = authSchema.table("order_payments", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	orderId: uuid("order_id").notNull(),
	walletId: uuid("wallet_id").notNull(),
	ledgerEntryId: uuid("ledger_entry_id"),
	paymentMethod: orderPaymentMethodEnum("payment_method").default('wallet').notNull(),
	amountMinor: integer("amount_minor").notNull(),
	currency: text().default('THB').notNull(),
	status: paymentStatusEnum().default('pending').notNull(),
	idempotencyKey: text("idempotency_key").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	deletedAt: timestamp("deleted_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	uniqueIndex("order_payments_idempotency_key_unique").using("btree", table.idempotencyKey.asc().nullsLast().op("text_ops")),
	uniqueIndex("order_payments_ledger_entry_id_unique").using("btree", table.ledgerEntryId.asc().nullsLast().op("uuid_ops")),
	uniqueIndex("order_payments_order_id_unique").using("btree", table.orderId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.orderId],
			foreignColumns: [orders.id],
			name: "order_payments_order_id_orders_id_fk"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.walletId],
			foreignColumns: [wallets.id],
			name: "order_payments_wallet_id_wallets_id_fk"
		}).onDelete("restrict"),
	foreignKey({
			columns: [table.ledgerEntryId],
			foreignColumns: [walletLedgerEntries.id],
			name: "order_payments_ledger_entry_id_wallet_ledger_entries_id_fk"
		}).onDelete("restrict"),
]);
