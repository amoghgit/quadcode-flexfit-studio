import { asc, and, eq } from "drizzle-orm";
import {
  bookings,
  memberships,
  corporateBookings,
  companies,
} from "@/db/schema";

/**
 * Database client type used throughout the application.
 * Accepts both the root `db` instance and a Drizzle transaction context,
 * since they share the same query interface.
 */
type DbClient = typeof import("@/db").db;

/** Hardcoded unlimited-credits sentinel matching the existing codebase. */
const UNLIMITED_CREDITS = 999;

/**
 * Centralised waitlist promotion logic.
 *
 * Previously this behaviour was duplicated in:
 *   - src/server/routers/bookings.ts   (cancel mutation, standard bookings)
 *   - src/server/routers/corporate-bookings.ts (cancel mutation, corporate bookings)
 *
 * Both implementations followed the same algorithm:
 *   1. Find the oldest waitlisted entry for the class.
 *   2. Promote it to "booked" with the class's creditCost.
 *   3. Deduct credits from the appropriate source (membership or company pool).
 *
 * This module extracts those two implementations faithfully, preserving every
 * edge-case behaviour — including the subtle differences between standard and
 * corporate credit deduction.
 */
export const WaitlistService = {
  /**
   * Promote the next waitlisted standard booking for a class.
   *
   * Behaviour preserved from bookings.ts cancel mutation (L213–L251):
   *   - Selects the oldest waitlisted booking by `bookedAt` (ASC).
   *   - Updates status to "booked" and sets creditsUsed to `creditCost`.
   *   - Deducts credits from the promoted user's membership, clamped to 0.
   *   - Skips deduction for unlimited memberships (creditsRemaining >= 999).
   *   - If no waitlisted entry exists, does nothing.
   *   - If the promoted booking has no membershipId, skips credit deduction.
   *
   * @param tx  Drizzle db client or transaction context.
   * @param classId  The class that now has an open spot.
   * @param creditCost  The class's credit cost to charge the promoted member.
   * @returns  Whether a promotion occurred and the promoted booking's ID.
   */
  async promoteNextFromWaitlist(
    tx: DbClient,
    classId: number,
    creditCost: number,
  ): Promise<{ promoted: boolean; bookingId?: number }> {
    const next = await tx
      .select()
      .from(bookings)
      .where(
        and(
          eq(bookings.classId, classId),
          eq(bookings.status, "waitlisted"),
        ),
      )
      .orderBy(asc(bookings.bookedAt))
      .get();

    if (!next) {
      return { promoted: false };
    }

    await tx
      .update(bookings)
      .set({ status: "booked", creditsUsed: creditCost })
      .where(eq(bookings.id, next.id));

    if (next.membershipId) {
      const ms = await tx
        .select()
        .from(memberships)
        .where(eq(memberships.id, next.membershipId))
        .get();

      if (ms && ms.creditsRemaining < UNLIMITED_CREDITS) {
        await tx
          .update(memberships)
          .set({
            creditsRemaining: Math.max(
              0,
              ms.creditsRemaining - creditCost,
            ),
          })
          .where(eq(memberships.id, ms.id));
      }
    }

    return { promoted: true, bookingId: next.id };
  },

  /**
   * Promote the next waitlisted corporate booking for a class.
   *
   * Behaviour preserved from corporate-bookings.ts cancel mutation (L225–L261):
   *   - Selects the oldest waitlisted corporate booking by `bookedAt` (ASC).
   *   - Updates status to "booked" and sets creditsUsed to `creditCost`.
   *   - Deducts credits from the company's credit pool, clamped to 0.
   *   - Deduction is conditional: only occurs if `creditPoolBalance >= creditCost`.
   *   - If no waitlisted entry exists, does nothing.
   *
   * Note the subtle difference from standard promotion:
   *   Standard uses `Math.max(0, remaining - cost)` unconditionally.
   *   Corporate guards deduction with `balance >= cost` first, then also
   *   uses `Math.max(0, balance - cost)`. This means if the company has
   *   insufficient credits, the booking is still promoted but no credits
   *   are deducted.
   *
   * @param tx  Drizzle db client or transaction context.
   * @param classId  The class that now has an open spot.
   * @param creditCost  The class's credit cost to charge the company.
   * @returns  Whether a promotion occurred and the promoted booking's ID.
   */
  async promoteNextCorporateFromWaitlist(
    tx: DbClient,
    classId: number,
    creditCost: number,
  ): Promise<{ promoted: boolean; bookingId?: number }> {
    const next = await tx
      .select()
      .from(corporateBookings)
      .where(
        and(
          eq(corporateBookings.classId, classId),
          eq(corporateBookings.status, "waitlisted"),
        ),
      )
      .orderBy(asc(corporateBookings.bookedAt))
      .get();

    if (!next) {
      return { promoted: false };
    }

    await tx
      .update(corporateBookings)
      .set({ status: "booked", creditsUsed: creditCost })
      .where(eq(corporateBookings.id, next.id));

    const company = await tx
      .select()
      .from(companies)
      .where(eq(companies.id, next.companyId))
      .get();

    if (company && company.creditPoolBalance >= creditCost) {
      await tx
        .update(companies)
        .set({
          creditPoolBalance: Math.max(
            0,
            company.creditPoolBalance - creditCost,
          ),
        })
        .where(eq(companies.id, company.id));
    }

    return { promoted: true, bookingId: next.id };
  },
};
