import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema/auth";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error(
    "DATABASE_URL is not set. Copy apps/api/.env.example to apps/api/.env and fill it in.",
  );
}

// `prepare: false` keeps this compatible with transaction-mode connection
// poolers (e.g. Supabase/pgbouncer). SSL is read from the URL (sslmode=require).
const client = postgres(connectionString, { prepare: false });

export const db = drizzle(client, { schema });
export { schema };
