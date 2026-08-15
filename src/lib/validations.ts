import { z } from "zod";

export const idSchema = z.object({ id: z.number() });
export const classIdSchema = z.object({ classId: z.number() });
export const bookingIdSchema = z.object({ bookingId: z.number() });
export const includePastSchema = z.object({ includePast: z.boolean().default(false) }).default({});
export const limitSchema = z.object({ limit: z.number().default(50) }).default({});
export const markAttendedSchema = z.object({
  bookingId: z.number(),
  source: z.enum(["front_desk", "kiosk", "app"]).default("front_desk"),
});
