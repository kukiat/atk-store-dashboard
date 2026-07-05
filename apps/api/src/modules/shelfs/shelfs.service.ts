import { Elysia, status } from "elysia";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "../../db";
import { shelfs } from "../../db/schema";

// Only expose public columns — never leak the internal `deleted_at` marker.
const publicColumns = {
  id: shelfs.id,
  groupId: shelfs.groupId,
  name: shelfs.name,
  imageUrl: shelfs.imageUrl,
  sensorId: shelfs.sensorId,
  createdAt: shelfs.createdAt,
  updatedAt: shelfs.updatedAt,
};

type CreateInput = {
  name: string;
  groupId?: string | null;
  imageUrl?: string | null;
  sensorId?: string | null;
};
type UpdateInput = Partial<CreateInput>;

export const shelfsService = new Elysia({ name: "shelfs.service" }).decorate(
  "shelfsService",
  {
    list() {
      return db
        .select(publicColumns)
        .from(shelfs)
        .where(isNull(shelfs.deletedAt))
        .orderBy(desc(shelfs.createdAt));
    },

    async findById(id: string) {
      const [row] = await db
        .select(publicColumns)
        .from(shelfs)
        .where(and(eq(shelfs.id, id), isNull(shelfs.deletedAt)));
      if (!row) throw status(404, "Shelf not found");
      return row;
    },

    async create(input: CreateInput) {
      const [row] = await db.insert(shelfs).values(input).returning(publicColumns);
      return row;
    },

    async update(id: string, input: UpdateInput) {
      const [row] = await db
        .update(shelfs)
        .set({ ...input, updatedAt: new Date().toISOString() })
        .where(and(eq(shelfs.id, id), isNull(shelfs.deletedAt)))
        .returning(publicColumns);
      if (!row) throw status(404, "Shelf not found");
      return row;
    },

    async softDelete(id: string) {
      const [row] = await db
        .update(shelfs)
        .set({ deletedAt: new Date().toISOString() })
        .where(and(eq(shelfs.id, id), isNull(shelfs.deletedAt)))
        .returning({ id: shelfs.id });
      if (!row) throw status(404, "Shelf not found");
      return { id: row.id, deleted: true as const };
    },
  },
);
