import { asc, eq } from "drizzle-orm";
import {
  corporateBookings,
  classes,
  companies,
  users,
} from "@/db/schema";
import { router, protectedProcedure, staffProcedure } from "../trpc";
import { CorporateBookingService } from "../services/CorporateBookingService";
import {
  classIdSchema,
  bookingIdSchema,
  includePastSchema,
  markAttendedSchema,
} from "@/lib/validations";

export const corporateBookingsRouter = router({
  mine: protectedProcedure
    .input(includePastSchema)
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db
        .select({
          id: corporateBookings.id,
          status: corporateBookings.status,
          creditsUsed: corporateBookings.creditsUsed,
          bookedAt: corporateBookings.bookedAt,
          classId: classes.id,
          className: classes.name,
          room: classes.room,
          startsAt: classes.startsAt,
          durationMin: classes.durationMin,
          cancelled: classes.cancelled,
          companyName: companies.name,
        })
        .from(corporateBookings)
        .innerJoin(classes, eq(corporateBookings.classId, classes.id))
        .innerJoin(companies, eq(corporateBookings.companyId, companies.id))
        .where(eq(corporateBookings.userId, ctx.user.id))
        .orderBy(asc(classes.startsAt));

      const now = new Date();
      return rows.filter((r) =>
        input.includePast ? true : new Date(r.startsAt) >= now,
      );
    }),

  book: protectedProcedure
    .input(classIdSchema)
    .mutation(async ({ ctx, input }) => {
      return CorporateBookingService.bookClass(ctx.db, ctx.user.id, input.classId);
    }),

  cancel: protectedProcedure
    .input(bookingIdSchema)
    .mutation(async ({ ctx, input }) => {
      return CorporateBookingService.cancelBooking(
        ctx.db,
        ctx.user.id,
        ctx.user.role,
        input.bookingId,
      );
    }),

  markAttended: staffProcedure
    .input(markAttendedSchema)
    .mutation(async ({ ctx, input }) => {
      return CorporateBookingService.markAttended(
        ctx.db,
        input.bookingId,
        input.source,
      );
    }),

  rosterFor: staffProcedure
    .input(classIdSchema)
    .query(async ({ ctx, input }) => {
      const bookingRows = await ctx.db
        .select({
          bookingId: corporateBookings.id,
          status: corporateBookings.status,
          memberId: users.id,
          memberName: users.name,
          memberEmail: users.email,
          bookedAt: corporateBookings.bookedAt,
          companyName: companies.name,
        })
        .from(corporateBookings)
        .innerJoin(users, eq(corporateBookings.userId, users.id))
        .innerJoin(companies, eq(corporateBookings.companyId, companies.id))
        .where(eq(corporateBookings.classId, input.classId))
        .orderBy(asc(corporateBookings.bookedAt));

      return bookingRows;
    }),
});
