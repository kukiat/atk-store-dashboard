import { Elysia, status } from "elysia";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "../../db";
import { groups } from "../../db/schema";

// Only expose public columns — never leak the internal `deleted_at` marker.
const publicColumns = {
  id: groups.id,
  name: groups.name,
  createdAt: groups.createdAt,
  updatedAt: groups.updatedAt,
};

/**
 * Groups service exposed via Elysia DI (`.decorate`). Handlers receive it as
 * `groupsService` from context. Methods throw `status(404)` when a row is
 * missing; Elysia maps the thrown status centrally.
 */
class GroupsService {
  list() {
    return db
      .select(publicColumns)
      .from(groups)
      .where(isNull(groups.deletedAt))
      .orderBy(desc(groups.createdAt));
  }

  async findById(id: string) {
    const [row] = await db
      .select(publicColumns)
      .from(groups)
      .where(and(eq(groups.id, id), isNull(groups.deletedAt)));
    if (!row) throw status(404, "Group not found");
    return row;
  }

  async create(input: { name: string }) {
    const [row] = await db
      .insert(groups)
      .values({ name: input.name })
      .returning(publicColumns);
    return row;
  }

  async update(id: string, input: { name: string }) {
    const [row] = await db
      .update(groups)
      .set({ name: input.name, updatedAt: new Date().toISOString() })
      .where(and(eq(groups.id, id), isNull(groups.deletedAt)))
      .returning(publicColumns);
    if (!row) throw status(404, "Group not found");
    return row;
  }

  async softDelete(id: string) {
    const [row] = await db
      .update(groups)
      .set({ deletedAt: new Date().toISOString() })
      .where(and(eq(groups.id, id), isNull(groups.deletedAt)))
      .returning({ id: groups.id });
    if (!row) throw status(404, "Group not found");
    return { id: row.id, deleted: true as const };
  }
}

export const groupsService = new Elysia({ name: "groups.service" }).decorate(
  "groupsService",
  new GroupsService(),
);
