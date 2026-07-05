import { uniqueIndex, text, timestamp, jsonb, uuid, boolean } from "drizzle-orm/pg-core";
import { authSchema } from "./_schema";
import { stripeWebhookProcessingStatusEnum } from "./_enums";

export const stripeWebhookEvents = authSchema.table("stripe_webhook_events", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	stripeEventId: text("stripe_event_id").notNull(),
	eventType: text("event_type").notNull(),
	livemode: boolean().default(false).notNull(),
	processingStatus: stripeWebhookProcessingStatusEnum("processing_status").default('processing').notNull(),
	payload: jsonb().notNull(),
	errorMessage: text("error_message"),
	processedAt: timestamp("processed_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	deletedAt: timestamp("deleted_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	uniqueIndex("stripe_webhook_events_event_id_unique").using("btree", table.stripeEventId.asc().nullsLast().op("text_ops")),
]);
