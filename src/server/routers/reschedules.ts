import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import {
  reschedules,
  bookings,
  classes,
  memberships,
} from "@/db/schema";
import { router, protectedProcedure } from "../trpc";
import { FREE_RESCHEDULE_HOURS } from "@/lib/constants";


function hoursUntil(iso: string, now = new Date()): number {
  return (new Date(iso).getTime() - now.getTime()) / 36e5;
}

async function activeMembershipFor(
  db: typeof import("@/db").db,
  userId: number,
) {
  const today = new Date().toISOString().slice(0, 10);
  return db
    .select()
    .from(memberships)
    .where(
      and(
        eq(memberships.userId, userId),
        eq(memberships.status, "active"),
        sql`${memberships.endDate} >= ${today}`,
      ),
    )
    .orderBy(desc(memberships.endDate))
    .get();
}

export const reschedulesRouter = router({
  reschedule: protectedProcedure
    .input(
      z.object({
        fromBookingId: z.number(),
        toClassId: z.number(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // Get the original booking with its class details
      const originalRow = await ctx.db
        .select({
          booking: bookings,
          cls: classes,
        })
        .from(bookings)
        .innerJoin(classes, eq(bookings.classId, classes.id))
        .where(eq(bookings.id, input.fromBookingId))
        .get();

      if (!originalRow) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Booking not found.",
        });
      }

      const originalBooking = originalRow.booking;
      const originalClass = originalRow.cls;

      // Verify ownership
      if (originalBooking.userId !== ctx.user.id) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "You cannot reschedule this booking.",
        });
      }

      // Verify booking is still active
      if (originalBooking.status !== "booked" && originalBooking.status !== "waitlisted") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "This booking is no longer active.",
        });
      }

      // Verify reschedule is allowed (within 4 hours of original class)
      const hoursBeforeOriginal = hoursUntil(originalClass.startsAt);
      if (hoursBeforeOriginal < FREE_RESCHEDULE_HOURS) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `You can only reschedule up to ${FREE_RESCHEDULE_HOURS} hours before the class starts.`,
        });
      }

      // Get target class
      const targetClass = await ctx.db
        .select()
        .from(classes)
        .where(eq(classes.id, input.toClassId))
        .get();

      if (!targetClass) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Target class not found.",
        });
      }

      // Verify target class has the same name
      if (targetClass.name !== originalClass.name) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "You can only reschedule to a class with the same name.",
        });
      }

      // Verify target class is not the same class
      if (targetClass.id === originalClass.id) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "You are already booked for this class.",
        });
      }

      // Verify target class hasn't started
      if (hoursUntil(targetClass.startsAt) <= 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "This class has already started.",
        });
      }

      // Verify target class is not cancelled
      if (targetClass.cancelled) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "This class has been cancelled.",
        });
      }

      // Check if user already has an active booking for this class
      const existingBooking = await ctx.db
        .select()
        .from(bookings)
        .where(
          and(
            eq(bookings.classId, targetClass.id),
            eq(bookings.userId, ctx.user.id),
            sql`${bookings.status} in ('booked', 'waitlisted')`,
          ),
        )
        .get();

      if (existingBooking) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "You already have an active booking for this class.",
        });
      }

      // Check if target class is full
      const [{ count }] = await ctx.db
        .select({ count: sql<number>`count(*)` })
        .from(bookings)
        .where(
          and(eq(bookings.classId, targetClass.id), eq(bookings.status, "booked")),
        );

      const targetIsFull = Number(count) >= targetClass.capacity;

      // Get the membership to check for unlimited credits
      const membership = originalBooking.membershipId
        ? await ctx.db
            .select()
            .from(memberships)
            .where(eq(memberships.id, originalBooking.membershipId))
            .get()
        : null;

      // Create the new booking (don't charge credits, they keep what they spent)
      const newBooking = await ctx.db
        .insert(bookings)
        .values({
          classId: targetClass.id,
          userId: ctx.user.id,
          membershipId: originalBooking.membershipId,
          status: targetIsFull ? "waitlisted" : "booked",
          creditsUsed: originalBooking.creditsUsed, // Keep the same credits used
        })
        .returning()
        .get();

      // Cancel the original booking
      await ctx.db
        .update(bookings)
        .set({
          status: "cancelled",
          cancelledAt: new Date().toISOString(),
        })
        .where(eq(bookings.id, originalBooking.id));

      // Record the reschedule
      await ctx.db.insert(reschedules).values({
        userId: ctx.user.id,
        fromBookingId: originalBooking.id,
        toBookingId: newBooking.id,
        fromClassId: originalClass.id,
        toClassId: targetClass.id,
      });

      return {
        ok: true,
        newBooking,
        newStatus: targetIsFull ? "waitlisted" : "booked",
      };
    }),

  history: protectedProcedure.query(async ({ ctx }) => {
    return ctx.db
      .select({
        id: reschedules.id,
        rescheduledAt: reschedules.rescheduledAt,
        fromClassName: classes.name,
        fromClassTime: sql<string>`(
          SELECT ${classes.startsAt} FROM ${classes}
          WHERE ${classes.id} = ${reschedules.fromClassId}
        )`,
        fromClassRoom: sql<string>`(
          SELECT ${classes.room} FROM ${classes}
          WHERE ${classes.id} = ${reschedules.fromClassId}
        )`,
        toClassName: sql<string>`(
          SELECT ${classes.name} FROM ${classes}
          WHERE ${classes.id} = ${reschedules.toClassId}
        )`,
        toClassTime: sql<string>`(
          SELECT ${classes.startsAt} FROM ${classes}
          WHERE ${classes.id} = ${reschedules.toClassId}
        )`,
        toClassRoom: sql<string>`(
          SELECT ${classes.room} FROM ${classes}
          WHERE ${classes.id} = ${reschedules.toClassId}
        )`,
      })
      .from(reschedules)
      .innerJoin(classes, eq(reschedules.fromClassId, classes.id))
      .where(eq(reschedules.userId, ctx.user.id))
      .orderBy(desc(reschedules.rescheduledAt));
  }),

  validateReschedule: protectedProcedure
    .input(
      z.object({
        fromBookingId: z.number(),
        toClassId: z.number(),
      }),
    )
    .query(async ({ ctx, input }) => {
      // Get the original booking with its class details
      const originalRow = await ctx.db
        .select({
          booking: bookings,
          cls: classes,
        })
        .from(bookings)
        .innerJoin(classes, eq(bookings.classId, classes.id))
        .where(eq(bookings.id, input.fromBookingId))
        .get();

      if (!originalRow) {
        return { valid: false, reason: "Booking not found." };
      }

      const originalBooking = originalRow.booking;
      const originalClass = originalRow.cls;

      // Verify ownership
      if (originalBooking.userId !== ctx.user.id) {
        return { valid: false, reason: "You cannot reschedule this booking." };
      }

      // Verify booking is still active
      if (
        originalBooking.status !== "booked" &&
        originalBooking.status !== "waitlisted"
      ) {
        return {
          valid: false,
          reason: "This booking is no longer active.",
        };
      }

      // Verify reschedule is allowed (within 4 hours of original class)
      const hoursBeforeOriginal = hoursUntil(originalClass.startsAt);
      if (hoursBeforeOriginal < FREE_RESCHEDULE_HOURS) {
        return {
          valid: false,
          reason: `You can only reschedule up to ${FREE_RESCHEDULE_HOURS} hours before the class starts.`,
        };
      }

      // Get target class
      const targetClass = await ctx.db
        .select()
        .from(classes)
        .where(eq(classes.id, input.toClassId))
        .get();

      if (!targetClass) {
        return { valid: false, reason: "Target class not found." };
      }

      // Verify target class has the same name
      if (targetClass.name !== originalClass.name) {
        return {
          valid: false,
          reason: "You can only reschedule to a class with the same name.",
        };
      }

      // Verify target class is not the same class
      if (targetClass.id === originalClass.id) {
        return {
          valid: false,
          reason: "You are already booked for this class.",
        };
      }

      // Verify target class hasn't started
      if (hoursUntil(targetClass.startsAt) <= 0) {
        return {
          valid: false,
          reason: "This class has already started.",
        };
      }

      // Verify target class is not cancelled
      if (targetClass.cancelled) {
        return {
          valid: false,
          reason: "This class has been cancelled.",
        };
      }

      // Check if user already has an active booking for this class
      const existingBooking = await ctx.db
        .select()
        .from(bookings)
        .where(
          and(
            eq(bookings.classId, targetClass.id),
            eq(bookings.userId, ctx.user.id),
            sql`${bookings.status} in ('booked', 'waitlisted')`,
          ),
        )
        .get();

      if (existingBooking) {
        return {
          valid: false,
          reason: "You already have an active booking for this class.",
        };
      }

      // Check if target class is full
      const [{ count }] = await ctx.db
        .select({ count: sql<number>`count(*)` })
        .from(bookings)
        .where(
          and(eq(bookings.classId, targetClass.id), eq(bookings.status, "booked")),
        );

      const targetIsFull = Number(count) >= targetClass.capacity;

      return {
        valid: true,
        targetIsFull,
      };
    }),
});
