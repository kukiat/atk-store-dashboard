import { relations } from "drizzle-orm/relations";
import { users } from "./users";
import { adminAuditLogs } from "./adminAuditLogs";
import { roles } from "./roles";
import { roleGrants } from "./roleGrants";
import { faceLivenessAttempts } from "./faceLivenessAttempts";
import { sessions } from "./sessions";
import { userFaceProfiles } from "./userFaceProfiles";
import { clientAttendanceEvents } from "./clientAttendanceEvents";
import { clientVisits } from "./clientVisits";
import { shelfs } from "./shelfs";
import { inventories } from "./inventories";
import { units } from "./units";
import { notifications } from "./notifications";
import { orders } from "./orders";
import { orderItems } from "./orderItems";
import { groups } from "./groups";
import { orderPayments } from "./orderPayments";
import { wallets } from "./wallets";
import { walletLedgerEntries } from "./walletLedgerEntries";
import { stripeCustomers } from "./stripeCustomers";
import { walletTopupIntents } from "./walletTopupIntents";
import { userRoles } from "./userRoles";

export const adminAuditLogsRelations = relations(adminAuditLogs, ({one}) => ({
	usersInAuth_actorUserId: one(users, {
		fields: [adminAuditLogs.actorUserId],
		references: [users.id],
		relationName: "adminAuditLogsInAuth_actorUserId_usersInAuth_id"
	}),
	usersInAuth_targetUserId: one(users, {
		fields: [adminAuditLogs.targetUserId],
		references: [users.id],
		relationName: "adminAuditLogsInAuth_targetUserId_usersInAuth_id"
	}),
}));

export const usersRelations = relations(users, ({many}) => ({
	adminAuditLogsInAuths_actorUserId: many(adminAuditLogs, {
		relationName: "adminAuditLogsInAuth_actorUserId_usersInAuth_id"
	}),
	adminAuditLogsInAuths_targetUserId: many(adminAuditLogs, {
		relationName: "adminAuditLogsInAuth_targetUserId_usersInAuth_id"
	}),
	roleGrantsInAuths_invitedByUserId: many(roleGrants, {
		relationName: "roleGrantsInAuth_invitedByUserId_usersInAuth_id"
	}),
	roleGrantsInAuths_acceptedByUserId: many(roleGrants, {
		relationName: "roleGrantsInAuth_acceptedByUserId_usersInAuth_id"
	}),
	faceLivenessAttemptsInAuths_userId: many(faceLivenessAttempts, {
		relationName: "faceLivenessAttemptsInAuth_userId_usersInAuth_id"
	}),
	faceLivenessAttemptsInAuths_matchedUserId: many(faceLivenessAttempts, {
		relationName: "faceLivenessAttemptsInAuth_matchedUserId_usersInAuth_id"
	}),
	sessionsInAuths: many(sessions),
	userFaceProfilesInAuths: many(userFaceProfiles),
	clientAttendanceEventsInAuths: many(clientAttendanceEvents),
	clientVisitsInAuths: many(clientVisits),
	notificationsInAuths: many(notifications),
	walletsInAuths: many(wallets),
	stripeCustomersInAuths: many(stripeCustomers),
	userRolesInAuths_assignedByUserId: many(userRoles, {
		relationName: "userRolesInAuth_assignedByUserId_usersInAuth_id"
	}),
	userRolesInAuths_userId: many(userRoles, {
		relationName: "userRolesInAuth_userId_usersInAuth_id"
	}),
}));

export const roleGrantsRelations = relations(roleGrants, ({one}) => ({
	roles: one(roles, {
		fields: [roleGrants.roleId],
		references: [roles.id]
	}),
	usersInAuth_invitedByUserId: one(users, {
		fields: [roleGrants.invitedByUserId],
		references: [users.id],
		relationName: "roleGrantsInAuth_invitedByUserId_usersInAuth_id"
	}),
	usersInAuth_acceptedByUserId: one(users, {
		fields: [roleGrants.acceptedByUserId],
		references: [users.id],
		relationName: "roleGrantsInAuth_acceptedByUserId_usersInAuth_id"
	}),
}));

export const rolesRelations = relations(roles, ({many}) => ({
	roleGrantsInAuths: many(roleGrants),
	userRolesInAuths: many(userRoles),
}));

export const faceLivenessAttemptsRelations = relations(faceLivenessAttempts, ({one, many}) => ({
	usersInAuth_userId: one(users, {
		fields: [faceLivenessAttempts.userId],
		references: [users.id],
		relationName: "faceLivenessAttemptsInAuth_userId_usersInAuth_id"
	}),
	usersInAuth_matchedUserId: one(users, {
		fields: [faceLivenessAttempts.matchedUserId],
		references: [users.id],
		relationName: "faceLivenessAttemptsInAuth_matchedUserId_usersInAuth_id"
	}),
	userFaceProfilesInAuths: many(userFaceProfiles),
}));

export const sessionsRelations = relations(sessions, ({one}) => ({
	users: one(users, {
		fields: [sessions.userId],
		references: [users.id]
	}),
}));

export const userFaceProfilesRelations = relations(userFaceProfiles, ({one}) => ({
	users: one(users, {
		fields: [userFaceProfiles.userId],
		references: [users.id]
	}),
	faceLivenessAttempts: one(faceLivenessAttempts, {
		fields: [userFaceProfiles.livenessAttemptId],
		references: [faceLivenessAttempts.id]
	}),
}));

export const clientAttendanceEventsRelations = relations(clientAttendanceEvents, ({one}) => ({
	users: one(users, {
		fields: [clientAttendanceEvents.matchedUserId],
		references: [users.id]
	}),
}));

export const clientVisitsRelations = relations(clientVisits, ({one, many}) => ({
	users: one(users, {
		fields: [clientVisits.userId],
		references: [users.id]
	}),
	notificationsInAuths: many(notifications),
	ordersInAuths: many(orders),
}));

export const shelfsRelations = relations(shelfs, ({one, many}) => ({
	groups: one(groups, {
		fields: [shelfs.groupId],
		references: [groups.id]
	}),
	inventoriesInAuths: many(inventories),
}));

export const groupsRelations = relations(groups, ({many}) => ({
	shelfsInAuths: many(shelfs),
}));

export const inventoriesRelations = relations(inventories, ({one, many}) => ({
	shelfs: one(shelfs, {
		fields: [inventories.shelfId],
		references: [shelfs.id]
	}),
	units: one(units, {
		fields: [inventories.unitId],
		references: [units.id]
	}),
	orderItemsInAuths: many(orderItems),
}));

export const unitsRelations = relations(units, ({many}) => ({
	inventoriesInAuths: many(inventories),
	orderItemsInAuths: many(orderItems),
}));

export const notificationsRelations = relations(notifications, ({one}) => ({
	clientVisits: one(clientVisits, {
		fields: [notifications.clientVisitId],
		references: [clientVisits.id]
	}),
	users: one(users, {
		fields: [notifications.userId],
		references: [users.id]
	}),
}));

export const ordersRelations = relations(orders, ({one, many}) => ({
	clientVisits: one(clientVisits, {
		fields: [orders.clientVisitId],
		references: [clientVisits.id]
	}),
	orderItemsInAuths: many(orderItems),
	orderPaymentsInAuths: many(orderPayments),
}));

export const orderItemsRelations = relations(orderItems, ({one}) => ({
	orders: one(orders, {
		fields: [orderItems.orderId],
		references: [orders.id]
	}),
	inventories: one(inventories, {
		fields: [orderItems.inventoryId],
		references: [inventories.id]
	}),
	units: one(units, {
		fields: [orderItems.unitId],
		references: [units.id]
	}),
}));

export const orderPaymentsRelations = relations(orderPayments, ({one}) => ({
	orders: one(orders, {
		fields: [orderPayments.orderId],
		references: [orders.id]
	}),
	wallets: one(wallets, {
		fields: [orderPayments.walletId],
		references: [wallets.id]
	}),
	walletLedgerEntries: one(walletLedgerEntries, {
		fields: [orderPayments.ledgerEntryId],
		references: [walletLedgerEntries.id]
	}),
}));

export const walletsRelations = relations(wallets, ({one, many}) => ({
	orderPaymentsInAuths: many(orderPayments),
	users: one(users, {
		fields: [wallets.userId],
		references: [users.id]
	}),
	walletLedgerEntriesInAuths: many(walletLedgerEntries),
	walletTopupIntentsInAuths: many(walletTopupIntents),
}));

export const walletLedgerEntriesRelations = relations(walletLedgerEntries, ({one, many}) => ({
	orderPaymentsInAuths: many(orderPayments),
	wallets: one(wallets, {
		fields: [walletLedgerEntries.walletId],
		references: [wallets.id]
	}),
}));

export const stripeCustomersRelations = relations(stripeCustomers, ({one, many}) => ({
	users: one(users, {
		fields: [stripeCustomers.userId],
		references: [users.id]
	}),
	walletTopupIntentsInAuths: many(walletTopupIntents),
}));

export const walletTopupIntentsRelations = relations(walletTopupIntents, ({one}) => ({
	wallets: one(wallets, {
		fields: [walletTopupIntents.walletId],
		references: [wallets.id]
	}),
	stripeCustomers: one(stripeCustomers, {
		fields: [walletTopupIntents.stripeCustomerRecordId],
		references: [stripeCustomers.id]
	}),
}));

export const userRolesRelations = relations(userRoles, ({one}) => ({
	roles: one(roles, {
		fields: [userRoles.roleId],
		references: [roles.id]
	}),
	usersInAuth_assignedByUserId: one(users, {
		fields: [userRoles.assignedByUserId],
		references: [users.id],
		relationName: "userRolesInAuth_assignedByUserId_usersInAuth_id"
	}),
	usersInAuth_userId: one(users, {
		fields: [userRoles.userId],
		references: [users.id],
		relationName: "userRolesInAuth_userId_usersInAuth_id"
	}),
}));