import { uniqueIndex, text, timestamp, integer, uuid, boolean } from "drizzle-orm/pg-core";
import { authSchema } from "./_schema";
import { walletFundingChannelEnum, walletFundingProviderEnum } from "./_enums";

export const walletFundingChannels = authSchema.table("wallet_funding_channels", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	provider: walletFundingProviderEnum().default('stripe').notNull(),
	channelCode: walletFundingChannelEnum("channel_code").notNull(),
	displayName: text("display_name").notNull(),
	stripePaymentMethodType: text("stripe_payment_method_type").notNull(),
	livemode: boolean().default(false).notNull(),
	minAmountMinor: integer("min_amount_minor").default(1000).notNull(),
	maxAmountMinor: integer("max_amount_minor").default(2000000).notNull(),
	isEnabled: boolean("is_enabled").default(true).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	deletedAt: timestamp("deleted_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	uniqueIndex("wallet_funding_channels_provider_code_livemode_unique").using("btree", table.provider.asc().nullsLast().op("bool_ops"), table.channelCode.asc().nullsLast().op("bool_ops"), table.livemode.asc().nullsLast().op("enum_ops")),
]);
