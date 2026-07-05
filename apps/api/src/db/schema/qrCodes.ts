import { text, timestamp, uuid } from "drizzle-orm/pg-core";
import { authSchema } from "./_schema";

export const qrCodes = authSchema.table("qr_codes", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	imageUrl: text("image_url"),
	shelfIds: text("shelf_ids").notNull(),
	encodedPayload: text("encoded_payload").notNull(),
	description: text(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	deletedAt: timestamp("deleted_at", { withTimezone: true, mode: 'string' }),
});
