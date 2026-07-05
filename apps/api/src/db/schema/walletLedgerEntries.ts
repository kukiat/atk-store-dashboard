import { uniqueIndex, text, timestamp, foreignKey, integer, jsonb, uuid } from "drizzle-orm/pg-core";
import { authSchema } from "./_schema";
import { walletLedgerDirectionEnum, walletLedgerTypeEnum } from "./_enums";
import { wallets } from "./wallets";

export const walletLedgerEntries = authSchema.table("wallet_ledger_entries", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	walletId: uuid("wallet_id").notNull(),
	direction: walletLedgerDirectionEnum().notNull(),
	type: walletLedgerTypeEnum().notNull(),
	amountMinor: integer("amount_minor").notNull(),
	currency: text().default('THB').notNull(),
	balanceAfterMinor: integer("balance_after_minor").notNull(),
	idempotencyKey: text("idempotency_key").notNull(),
	referenceType: text("reference_type"),
	referenceId: text("reference_id"),
	metadata: jsonb(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex("wallet_ledger_entries_idempotency_key_unique").using("btree", table.idempotencyKey.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.walletId],
			foreignColumns: [wallets.id],
			name: "wallet_ledger_entries_wallet_id_wallets_id_fk"
		}).onDelete("restrict"),
]);
