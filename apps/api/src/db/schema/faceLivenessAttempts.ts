import { uniqueIndex, unique, serial, text, timestamp, foreignKey, integer, doublePrecision } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { authSchema } from "./_schema";
import { faceLivenessIntentEnum, faceRecognitionOutcomeEnum, livenessAttemptStatusEnum } from "./_enums";
import { users } from "./users";

export const faceLivenessAttempts = authSchema.table("face_liveness_attempts", {
	id: serial().primaryKey().notNull(),
	userId: integer("user_id").notNull(),
	sessionId: text("session_id").notNull(),
	clientRequestToken: text("client_request_token").notNull(),
	intent: faceLivenessIntentEnum().default('enrollment').notNull(),
	status: livenessAttemptStatusEnum().default('pending').notNull(),
	confidence: doublePrecision(),
	referenceS3Key: text("reference_s3_key"),
	recognitionOutcome: faceRecognitionOutcomeEnum("recognition_outcome"),
	matchedFaceId: text("matched_face_id"),
	matchedUserId: integer("matched_user_id"),
	faceSimilarity: doublePrecision("face_similarity"),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex("face_liveness_attempts_one_active_per_user").using("btree", table.userId.asc().nullsLast().op("int4_ops")).where(sql`(status = 'pending'::auth.liveness_attempt_status)`),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "face_liveness_attempts_user_id_users_id_fk"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.matchedUserId],
			foreignColumns: [users.id],
			name: "face_liveness_attempts_matched_user_id_users_id_fk"
		}).onDelete("set null"),
	unique("face_liveness_attempts_session_id_unique").on(table.sessionId),
]);
