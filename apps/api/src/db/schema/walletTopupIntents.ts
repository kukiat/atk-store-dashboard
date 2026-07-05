import { uniqueIndex, text, timestamp, foreignKey, integer, jsonb, uuid, boolean } from "drizzle-orm/pg-core";
import { authSchema } from "./_schema";
import { walletFundingChannelEnum, walletTopupStatusEnum } from "./_enums";
import { wallets } from "./wallets";
import { stripeCustomers } from "./stripeCustomers";

export const walletTopupIntents = authSchema.table("wallet_topup_intents", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	walletId: uuid("wallet_id").notNull(),
	stripeCustomerRecordId: uuid("stripe_customer_record_id"),
	stripeCheckoutSessionId: text("stripe_checkout_session_id"),
	stripePaymentIntentId: text("stripe_payment_intent_id"),
	requestedChannel: walletFundingChannelEnum("requested_channel").notNull(),
	confirmedChannel: walletFundingChannelEnum("confirmed_channel"),
	amountMinor: integer("amount_minor").notNull(),
	currency: text().default('THB').notNull(),
	status: walletTopupStatusEnum().default('created').notNull(),
	livemode: boolean().default(false).notNull(),
	checkoutUrl: text("checkout_url"),
	paidAt: timestamp("paid_at", { withTimezone: true, mode: 'string' }),
	metadata: jsonb(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	deletedAt: timestamp("deleted_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	uniqueIndex("wallet_topup_intents_checkout_session_unique").using("btree", table.stripeCheckoutSessionId.asc().nullsLast().op("text_ops")),
	uniqueIndex("wallet_topup_intents_payment_intent_unique").using("btree", table.stripePaymentIntentId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.walletId],
			foreignColumns: [wallets.id],
			name: "wallet_topup_intents_wallet_id_wallets_id_fk"
		}).onDelete("restrict"),
	foreignKey({
			columns: [table.stripeCustomerRecordId],
			foreignColumns: [stripeCustomers.id],
			name: "wallet_topup_intents_stripe_customer_record_id_stripe_customers"
		}).onDelete("set null"),
]);
