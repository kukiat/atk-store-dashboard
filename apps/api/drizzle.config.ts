import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema/*",
  out: "./drizzle",
  // Database-first: restrict introspection (`drizzle-kit pull`) to the auth schema.
  schemaFilter: ["auth"],
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
