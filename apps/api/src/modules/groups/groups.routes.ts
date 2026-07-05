import { Elysia, t } from "elysia";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "../../db";
import { groups } from "../../db/schema/auth";

const uuidParams = t.Object({ id: t.String({ format: "uuid" }) });
const groupBody = t.Object({ name: t.String({ minLength: 1 }) });

export const groupsRoutes = new Elysia({ prefix: "/groups", tags: ["groups"] })
  // List all non-deleted groups
  .get("/", () =>
    db.select().from(groups).where(isNull(groups.deletedAt)).orderBy(desc(groups.createdAt)),
  )

  // Get one group by id
  .get(
    "/:id",
    async ({ params, set }) => {
      const [row] = await db
        .select()
        .from(groups)
        .where(and(eq(groups.id, params.id), isNull(groups.deletedAt)));
      if (!row) {
        set.status = 404;
        return { message: "Group not found" };
      }
      return row;
    },
    { params: uuidParams },
  )

  // Create a group
  .post(
    "/",
    async ({ body, set }) => {
      const [row] = await db.insert(groups).values({ name: body.name }).returning();
      set.status = 201;
      return row;
    },
    { body: groupBody },
  )

  // Update a group's name
  .patch(
    "/:id",
    async ({ params, body, set }) => {
      const [row] = await db
        .update(groups)
        .set({ name: body.name, updatedAt: new Date() })
        .where(and(eq(groups.id, params.id), isNull(groups.deletedAt)))
        .returning();
      if (!row) {
        set.status = 404;
        return { message: "Group not found" };
      }
      return row;
    },
    { params: uuidParams, body: groupBody },
  )

  // Soft delete: set deleted_at instead of removing the row
  .delete(
    "/:id",
    async ({ params, set }) => {
      const [row] = await db
        .update(groups)
        .set({ deletedAt: new Date() })
        .where(and(eq(groups.id, params.id), isNull(groups.deletedAt)))
        .returning();
      if (!row) {
        set.status = 404;
        return { message: "Group not found" };
      }
      return { id: row.id, deleted: true };
    },
    { params: uuidParams },
  );
