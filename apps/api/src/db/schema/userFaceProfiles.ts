import { uniqueIndex, serial, text, timestamp, foreignKey, integer, doublePrecision } from "drizzle-orm/pg-core";
import { authSchema } from "./_schema";
import { users } from "./users";
import { faceLivenessAttempts } from "./faceLivenessAttempts";

export const userFaceProfiles = authSchema.table("user_face_profiles", {
	id: serial().primaryKey().notNull(),
	userId: integer("user_id").notNull(),
	collectionId: text("collection_id").notNull(),
	faceId: text("face_id").notNull(),
	imageId: text("image_id"),
	externalImageId: text("external_image_id").notNull(),
	confidence: doublePrecision(),
	referenceS3Key: text("reference_s3_key"),
	livenessAttemptId: integer("liveness_attempt_id"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex("user_face_profiles_face_id_unique").using("btree", table.faceId.asc().nullsLast().op("text_ops")),
	uniqueIndex("user_face_profiles_user_id_unique").using("btree", table.userId.asc().nullsLast().op("int4_ops")),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "user_face_profiles_user_id_users_id_fk"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.livenessAttemptId],
			foreignColumns: [faceLivenessAttempts.id],
			name: "user_face_profiles_liveness_attempt_id_face_liveness_attempts_i"
		}).onDelete("set null"),
]);
