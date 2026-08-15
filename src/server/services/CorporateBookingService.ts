import { TRPCError } from "@trpc/server";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  corporateBookings,
  classes,
  companies,
  companyMembers,
  checkins,
} from "@/db/schema";
import { WaitlistService } from "./WaitlistService";

type DbClient = typeof import("@/db").db;

export const CORPORATE_FREE_CANCELLATION_HOURS = 24;

function hoursUntil(iso: string, now = new Date()): number {
  return (new Date(iso).getTime() - now.getTime()) / 36e5;
}

async function getCompanyForMember(db: DbClient, userId: number) {
  return db
    .select()
    .from(companyMembers)
    .innerJoin(companies, eq(companyMembers.companyId, companies.id))
    .where(and(eq(companyMembers.userId, userId), eq(companies.active, true)))
    .get();
}

export const CorporateBookingService = {
  async bookClass(tx: DbClient, userId: number, classId: number) {
    const cls = await tx
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

    const existing = await tx
      .select()
      .from(corporateBookings)
      .where(
        and(
          eq(corporateBookings.classId, cls.id),
          eq(corporateBookings.userId, userId),
          inArray(corporateBookings.status, ["booked", "waitlisted"]),
        ),
      )
      .get();

    if (existing) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "You are already on the list for this class.",
      });
    }

    const companyRow = await getCompanyForMember(tx, userId);
    if (!companyRow) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "You are not linked to an active company.",
      });
    }

    const company = companyRow.companies;
    if (company.creditPoolBalance < cls.creditCost) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "Your company does not have enough credits.",
      });
    }

    const [{ count }] = await tx
      .select({ count: sql<number>`count(*)` })
      .from(corporateBookings)
      .where(
        and(
          eq(corporateBookings.classId, cls.id),
          eq(corporateBookings.status, "booked"),
        ),
      );

    const isFull = Number(count) >= cls.capacity;

    const created = await tx
      .insert(corporateBookings)
      .values({
        classId: cls.id,
        userId,
        companyId: company.id,
        status: isFull ? "waitlisted" : "booked",
        creditsUsed: isFull ? 0 : cls.creditCost,
      })
      .returning()
      .get();

    if (!isFull) {
      await tx
        .update(companies)
        .set({
          creditPoolBalance: company.creditPoolBalance - cls.creditCost,
        })
        .where(eq(companies.id, company.id));
    }

    return created;
  },

  async cancelBooking(
    tx: DbClient,
    userId: number,
    userRole: string,
    bookingId: number,
  ) {
    const row = await tx
      .select({ booking: corporateBookings, cls: classes })
      .from(corporateBookings)
      .innerJoin(classes, eq(corporateBookings.classId, classes.id))
      .where(eq(corporateBookings.id, bookingId))
      .get();

    if (!row) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Booking not found." });
    }

    const isOwner = row.booking.userId === userId;
    const isStaff = userRole === "admin" || userRole === "trainer";
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
      hoursUntil(row.cls.startsAt) >= CORPORATE_FREE_CANCELLATION_HOURS &&
      row.booking.creditsUsed > 0;

    await tx
      .update(corporateBookings)
      .set({ status: "cancelled", cancelledAt: new Date().toISOString() })
      .where(eq(corporateBookings.id, row.booking.id));

    if (refundable) {
      const company = await tx
        .select()
        .from(companies)
        .where(eq(companies.id, row.booking.companyId))
        .get();

      if (company) {
        await tx
          .update(companies)
          .set({
            creditPoolBalance:
              company.creditPoolBalance + row.booking.creditsUsed,
          })
          .where(eq(companies.id, company.id));
      }
    }

    if (row.booking.status === "booked") {
      await WaitlistService.promoteNextCorporateFromWaitlist(
        tx,
        row.cls.id,
        row.cls.creditCost,
      );
    }

    return { ok: true, refunded: refundable };
  },

  async markAttended(tx: DbClient, bookingId: number, source: string) {
    const booking = await tx
      .select()
      .from(corporateBookings)
      .where(eq(corporateBookings.id, bookingId))
      .get();

    if (!booking) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Booking not found." });
    }
    if (booking.status !== "booked") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Only confirmed bookings can be checked in.",
      });
    }

    await tx
      .update(corporateBookings)
      .set({ status: "attended" })
      .where(eq(corporateBookings.id, booking.id));

    // KNOWN BUG PRESERVED: bookingId is null
    await tx.insert(checkins).values({
      userId: booking.userId,
      bookingId: null as any,
    });

    return { ok: true };
  },
};
