import { uniqueIndex, unique, serial, text, timestamp } from "drizzle-orm/pg-core";
import { authSchema } from "./_schema";
import { authMethodEnum, faceEnrollmentStatusEnum, userAccountStatusEnum } from "./_enums";

export const users = authSchema.table("users", {
	id: serial().primaryKey().notNull(),
	email: text().notNull(),
	name: text(),
	avatarUrl: text("avatar_url"),
	authMethod: authMethodEnum("auth_method").default('google').notNull(),
	providerAccountId: text("provider_account_id"),
	faceEnrollmentStatus: faceEnrollmentStatusEnum("face_enrollment_status").default('not_registered').notNull(),
	faceRegisteredAt: timestamp("face_registered_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	lastLoginAt: timestamp("last_login_at", { withTimezone: true, mode: 'string' }),
	accountStatus: userAccountStatusEnum("account_status").default('active').notNull(),
	disabledUntil: timestamp("disabled_until", { withTimezone: true, mode: 'string' }),
	disabledReason: text("disabled_reason"),
}, (table) => [
	uniqueIndex("users_auth_method_provider_account_id_unique").using("btree", table.authMethod.asc().nullsLast().op("text_ops"), table.providerAccountId.asc().nullsLast().op("text_ops")),
	unique("users_email_unique").on(table.email),
]);
