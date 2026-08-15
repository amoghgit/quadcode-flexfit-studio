/**
 * BookingService — domain operations for class bookings.
 *
 * This service owns the business rules for:
 *   • Booking a class (eligibility, capacity, credit deduction)
 *   • Cancelling a booking (refund window, waitlist promotion)
 *   • Rescheduling a booking (same-class-type constraint, credit carry-over)
 *
 * IMPORTANT — KNOWN BUG PRESERVED:
 *   Rescheduling does NOT promote a waitlisted user from the original class.
 *   This is a documented defect in BASELINE.md and must NOT be fixed during
 *   this refactor phase.
 *
 * Transaction boundaries:
 *   • bookClass:  insert booking + deduct credits  (atomic)
 *   • cancelBooking: update booking + refund credits + promote waitlisted  (atomic)
 *   • rescheduleBooking: cancel old + create new + record reschedule  (atomic)
 *
 * Note on failure semantics:
 *   Previously, each SQL statement was independent — a crash mid-mutation
 *   could leave the database in an inconsistent state (e.g. booking
 *   cancelled but credits not refunded).  With transactions, a failure
 *   during the mutation now rolls back ALL changes.  This is strictly
 *   safer for the user but means a transient DB error that previously
 *   might have partially succeeded will now fully fail.
 */

import { WaitlistService } from "./WaitlistService";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  bookings,
  classes,
  memberships,
  reschedules,
} from "@/db/schema";
import {
  FREE_CANCELLATION_HOURS,
  FREE_RESCHEDULE_HOURS,
  UNLIMITED_CREDITS,
} from "@/lib/constants";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The database instance type used throughout the app. */
export type Db = typeof import("@/db").db;

/** Minimal user context needed by booking operations. */
export interface BookingUser {
  id: number;
  role: "member" | "trainer" | "admin";
}

// ---------------------------------------------------------------------------
// Helpers (internal)
// ---------------------------------------------------------------------------

function hoursUntil(iso: string, now = new Date()): number {
  return (new Date(iso).getTime() - now.getTime()) / 36e5;
}

async function activeMembershipFor(db: Db, userId: number) {
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

// ---------------------------------------------------------------------------
// BookingService
// ---------------------------------------------------------------------------

export const BookingService = {
  /**
   * Book a class for a member.
   *
   * Business rules:
   *   1. Class must exist, not be cancelled, and not have started.
   *   2. Member must not already have an active booking for this class.
   *   3. Member must have an active membership with sufficient credits.
   *   4. If the class is full, the member is waitlisted (0 credits charged).
   *   5. Unlimited memberships (credits >= 999) never decrement.
   */
  async bookClass(db: Db, userId: number, classId: number) {
    const cls = await db
      .select()
      .from(classes)
      .where(eq(classes.id, classId))
      .get();

    if (!cls) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Class not found." });
    }
    if (cls.cancelled) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "This class has been cancelled.",
      });
    }
    if (hoursUntil(cls.startsAt) <= 0) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "This class has already started.",
      });
    }

    const existing = await db
      .select()
      .from(bookings)
      .where(
        and(
          eq(bookings.classId, cls.id),
          eq(bookings.userId, userId),
          inArray(bookings.status, ["booked", "waitlisted"]),
        ),
      )
      .get();

    if (existing) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "You are already on the list for this class.",
      });
    }

    const membership = await activeMembershipFor(db, userId);
    if (!membership) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "An active membership is required to book classes.",
      });
    }

    const unlimited = membership.creditsRemaining >= UNLIMITED_CREDITS;
    if (!unlimited && membership.creditsRemaining < cls.creditCost) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "Not enough class credits remaining.",
      });
    }

    const [{ count }] = await db
      .select({ count: sql<number>`count(*)` })
      .from(bookings)
      .where(
        and(eq(bookings.classId, cls.id), eq(bookings.status, "booked")),
      );

    const isFull = Number(count) >= cls.capacity;

    // --- atomic: insert booking + deduct credits ---
    return db.transaction(async (tx) => {
      const created = await tx
        .insert(bookings)
        .values({
          classId: cls.id,
          userId,
          membershipId: membership.id,
          status: isFull ? "waitlisted" : "booked",
          creditsUsed: isFull ? 0 : cls.creditCost,
        })
        .returning()
        .get();

      if (!isFull && !unlimited) {
        await tx
          .update(memberships)
          .set({ creditsRemaining: membership.creditsRemaining - cls.creditCost })
          .where(eq(memberships.id, membership.id));
      }

      return created;
    });
  },

  /**
   * Cancel a booking.
   *
   * Business rules:
   *   1. Only the booking owner or staff (admin/trainer) may cancel.
   *   2. Only "booked" or "waitlisted" bookings may be cancelled.
   *   3. Credits are refunded only if cancelled >= 12 hours before class start
   *      AND credits were actually charged.
   *   4. When a confirmed ("booked") spot is freed, the oldest waitlisted
   *      member is promoted and charged credits.
   */
  async cancelBooking(
    db: Db,
    user: BookingUser,
    bookingId: number,
  ) {
    const row = await db
      .select({ booking: bookings, cls: classes })
      .from(bookings)
      .innerJoin(classes, eq(bookings.classId, classes.id))
      .where(eq(bookings.id, bookingId))
      .get();

    if (!row) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Booking not found." });
    }

    const isOwner = row.booking.userId === user.id;
    const isStaff = user.role === "admin" || user.role === "trainer";
    if (!isOwner && !isStaff) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "You cannot cancel this booking.",
      });
    }

    if (row.booking.status !== "booked" && row.booking.status !== "waitlisted") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "This booking is no longer active.",
      });
    }

    const refundable =
      hoursUntil(row.cls.startsAt) >= FREE_CANCELLATION_HOURS &&
      row.booking.creditsUsed > 0;

    // --- atomic: cancel + refund + promote ---
    await db.transaction(async (tx) => {
      await tx
        .update(bookings)
        .set({ status: "cancelled", cancelledAt: new Date().toISOString() })
        .where(eq(bookings.id, row.booking.id));

      if (refundable && row.booking.membershipId) {
        const ms = await tx
          .select()
          .from(memberships)
          .where(eq(memberships.id, row.booking.membershipId))
          .get();

        if (ms && ms.creditsRemaining < UNLIMITED_CREDITS) {
          await tx
            .update(memberships)
            .set({ creditsRemaining: ms.creditsRemaining + row.booking.creditsUsed })
            .where(eq(memberships.id, ms.id));
        }
      }

      // Freeing a confirmed spot promotes the member who has waited longest.
      if (row.booking.status === "booked") {
        await WaitlistService.promoteNextFromWaitlist(
          tx,
          row.cls.id,
          row.cls.creditCost,
        );
      }
    });

    return { ok: true, refunded: refundable };
  },

  /**
   * Reschedule a booking to a different class of the same type.
   *
   * Business rules:
   *   1. Only the booking owner may reschedule.
   *   2. Only "booked" or "waitlisted" bookings may be rescheduled.
   *   3. Reschedule must be requested >= 4 hours before original class.
   *   4. Target class must have the same name, must not be cancelled, must
   *      not have started, and must not already have an active booking for
   *      this user.
   *   5. Credits are carried over (not re-charged or refunded).
   *   6. KNOWN BUG: waitlisted users on the original class are NOT promoted.
   */
  async rescheduleBooking(
    db: Db,
    userId: number,
    fromBookingId: number,
    toClassId: number,
  ) {
    // Get the original booking with its class details
    const originalRow = await db
      .select({
        booking: bookings,
        cls: classes,
      })
      .from(bookings)
      .innerJoin(classes, eq(bookings.classId, classes.id))
      .where(eq(bookings.id, fromBookingId))
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
    if (originalBooking.userId !== userId) {
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

    // Verify reschedule is allowed (within window of original class)
    const hoursBeforeOriginal = hoursUntil(originalClass.startsAt);
    if (hoursBeforeOriginal < FREE_RESCHEDULE_HOURS) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `You can only reschedule up to ${FREE_RESCHEDULE_HOURS} hours before the class starts.`,
      });
    }

    // Get target class
    const targetClass = await db
      .select()
      .from(classes)
      .where(eq(classes.id, toClassId))
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
    const existingBooking = await db
      .select()
      .from(bookings)
      .where(
        and(
          eq(bookings.classId, targetClass.id),
          eq(bookings.userId, userId),
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
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)` })
      .from(bookings)
      .where(
        and(eq(bookings.classId, targetClass.id), eq(bookings.status, "booked")),
      );

    const targetIsFull = Number(count) >= targetClass.capacity;

    // --- atomic: create new booking + cancel old + record reschedule ---
    // NOTE: KNOWN BUG — waitlisted users on originalClass are NOT promoted.
    const newBooking = await db.transaction(async (tx) => {
      const created = await tx
        .insert(bookings)
        .values({
          classId: targetClass.id,
          userId,
          membershipId: originalBooking.membershipId,
          status: targetIsFull ? "waitlisted" : "booked",
          creditsUsed: originalBooking.creditsUsed, // Keep the same credits used
        })
        .returning()
        .get();

      // Cancel the original booking
      await tx
        .update(bookings)
        .set({
          status: "cancelled",
          cancelledAt: new Date().toISOString(),
        })
        .where(eq(bookings.id, originalBooking.id));

      // Record the reschedule
      await tx.insert(reschedules).values({
        userId,
        fromBookingId: originalBooking.id,
        toBookingId: created.id,
        fromClassId: originalClass.id,
        toClassId: targetClass.id,
      });

      return created;
    });

    return {
      ok: true,
      newBooking,
      newStatus: targetIsFull ? "waitlisted" : "booked",
    };
  },
};
