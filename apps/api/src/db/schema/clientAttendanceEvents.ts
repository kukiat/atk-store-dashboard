import { serial, text, timestamp, foreignKey, integer, jsonb, doublePrecision } from "drizzle-orm/pg-core";
import { authSchema } from "./_schema";
import { attendanceDirectionEnum, attendanceRecognitionDecisionEnum } from "./_enums";
import { users } from "./users";

export const clientAttendanceEvents = authSchema.table("client_attendance_events", {
	id: serial().primaryKey().notNull(),
	cameraId: text("camera_id").notNull(),
	direction: attendanceDirectionEnum().notNull(),
	decision: attendanceRecognitionDecisionEnum().notNull(),
	matchedUserId: integer("matched_user_id"),
	matchedFaceId: text("matched_face_id"),
	similarity: doublePrecision(),
	imageSha256: text("image_sha256").notNull(),
	workerCapturedAt: timestamp("worker_captured_at", { withTimezone: true, mode: 'string' }),
	metadata: jsonb(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.matchedUserId],
			foreignColumns: [users.id],
			name: "client_attendance_events_matched_user_id_users_id_fk"
		}).onDelete("set null"),
]);
