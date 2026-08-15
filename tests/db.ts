import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import * as schema from "../src/db/schema";
import { execSync } from "child_process";
import fs from "fs";
import crypto from "crypto";

let _db: ReturnType<typeof drizzle> | null = null;
let _client: ReturnType<typeof createClient> | null = null;
const DB_FILE = `test-flexfit-${crypto.randomBytes(4).toString("hex")}.db`;

export function getTestDb() {
  if (_db) return _db;

  // Cleanup old test DB if it exists
  if (fs.existsSync(DB_FILE)) {
    fs.unlinkSync(DB_FILE);
  }

  // Create temporary config
  const config = `
import type { Config } from "drizzle-kit";
export default {
  schema: "./src/db/schema.ts",
  dialect: "turso",
  dbCredentials: { url: "file:${DB_FILE}" },
} satisfies Config;
`;
  const configPath = `drizzle.test.config.${crypto.randomBytes(4).toString("hex")}.ts`;
  fs.writeFileSync(configPath, config);

  // Push schema
  execSync(`npx drizzle-kit push --config ${configPath}`, {
    stdio: "ignore",
  });

  // Clean up temporary config
  fs.unlinkSync(configPath);

  _client = createClient({ url: `file:${DB_FILE}` });
  _db = drizzle(_client, { schema });

  return _db;
}

export async function clearTestDb(db: ReturnType<typeof drizzle>) {
  await db.delete(schema.reschedules);
  await db.delete(schema.corporateBookings);
  await db.delete(schema.companyMembers);
  await db.delete(schema.companies);
  await db.delete(schema.notifications);
  await db.delete(schema.sessions);
  await db.delete(schema.checkins);
  await db.delete(schema.bookings);
  await db.delete(schema.payments);
  await db.delete(schema.memberships);
  await db.delete(schema.classes);
  await db.delete(schema.membershipPlans);
  await db.delete(schema.trainerAvailability);
  await db.delete(schema.users);
}
