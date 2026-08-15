import { describe, it, expect, beforeEach } from "vitest";
import { getTestDb, clearTestDb } from "./db";
import {
  users,
  classes,
  bookings,
  memberships,
  membershipPlans,
  corporateBookings,
  companies,
  companyMembers,
} from "../src/db/schema";
import { eq } from "drizzle-orm";
import { WaitlistService } from "../src/server/services/WaitlistService";
import { appRouter } from "../src/server/routers/_app";

describe("WaitlistService", () => {
  const db = getTestDb();
  // Cast for direct WaitlistService calls — the test db is created without
  // schema typing (same pattern as existing bookings/reschedules tests).
  const typedDb = db as any;
  let limitedPlanId: number;

  beforeEach(async () => {
    await clearTestDb(db);

    const [limitedPlan] = await db
      .insert(membershipPlans)
      .values({
        name: "Drop-in",
        priceCents: 50,
        durationDays: 30,
        classCredits: 10,
      })
      .returning();
    limitedPlanId = limitedPlan.id;
  });

  // ───────────────────────────────────────────────
  // Standard booking promotion
  // ───────────────────────────────────────────────

  describe("promoteNextFromWaitlist", () => {
    it("returns promoted:false when the waitlist is empty", async () => {
      const [cls] = await db
        .insert(classes)
        .values({
          name: "Yoga",
          room: "A",
          capacity: 1,
          startsAt: new Date(Date.now() + 24 * 3600000).toISOString(),
        })
        .returning();

      const result = await WaitlistService.promoteNextFromWaitlist(typedDb, cls.id, 1);
      expect(result.promoted).toBe(false);
      expect(result.bookingId).toBeUndefined();
    });

    it("promotes one waiting member and deducts credits", async () => {
      const [user] = await db
        .insert(users)
        .values({ email: "w@test.com", passwordHash: "h", name: "W", role: "member" })
        .returning();
      const [ms] = await db
        .insert(memberships)
        .values({
          userId: user.id,
          planId: limitedPlanId,
          startDate: "2026-01-01",
          endDate: "2099-01-01",
          creditsRemaining: 10,
        })
        .returning();
      const [cls] = await db
        .insert(classes)
        .values({
          name: "Yoga",
          room: "A",
          capacity: 1,
          startsAt: new Date(Date.now() + 24 * 3600000).toISOString(),
          creditCost: 2,
        })
        .returning();
      const [waitlistedBooking] = await db
        .insert(bookings)
        .values({
          classId: cls.id,
          userId: user.id,
          membershipId: ms.id,
          status: "waitlisted",
          creditsUsed: 0,
        })
        .returning();

      const result = await WaitlistService.promoteNextFromWaitlist(typedDb, cls.id, cls.creditCost);

      expect(result.promoted).toBe(true);
      expect(result.bookingId).toBe(waitlistedBooking.id);

      const updated = await db.select().from(bookings).where(eq(bookings.id, waitlistedBooking.id)).get();
      expect(updated?.status).toBe("booked");
      expect(updated?.creditsUsed).toBe(2);

      const updatedMs = await db.select().from(memberships).where(eq(memberships.id, ms.id)).get();
      expect(updatedMs?.creditsRemaining).toBe(8); // 10 - 2
    });

    it("promotes the oldest waitlisted member first (FIFO by bookedAt)", async () => {
      const [user1] = await db
        .insert(users)
        .values({ email: "first@test.com", passwordHash: "h", name: "First", role: "member" })
        .returning();
      const [ms1] = await db
        .insert(memberships)
        .values({ userId: user1.id, planId: limitedPlanId, startDate: "2026-01-01", endDate: "2099-01-01", creditsRemaining: 10 })
        .returning();
      const [user2] = await db
        .insert(users)
        .values({ email: "second@test.com", passwordHash: "h", name: "Second", role: "member" })
        .returning();
      const [ms2] = await db
        .insert(memberships)
        .values({ userId: user2.id, planId: limitedPlanId, startDate: "2026-01-01", endDate: "2099-01-01", creditsRemaining: 10 })
        .returning();

      const [cls] = await db
        .insert(classes)
        .values({
          name: "Yoga",
          room: "A",
          capacity: 1,
          startsAt: new Date(Date.now() + 24 * 3600000).toISOString(),
          creditCost: 1,
        })
        .returning();

      // Insert first waitlisted, then second — first has earlier bookedAt
      const [b1] = await db
        .insert(bookings)
        .values({
          classId: cls.id,
          userId: user1.id,
          membershipId: ms1.id,
          status: "waitlisted",
          creditsUsed: 0,
          bookedAt: "2026-08-01T10:00:00.000Z",
        })
        .returning();
      const [b2] = await db
        .insert(bookings)
        .values({
          classId: cls.id,
          userId: user2.id,
          membershipId: ms2.id,
          status: "waitlisted",
          creditsUsed: 0,
          bookedAt: "2026-08-01T11:00:00.000Z",
        })
        .returning();

      const result = await WaitlistService.promoteNextFromWaitlist(typedDb, cls.id, cls.creditCost);

      expect(result.promoted).toBe(true);
      expect(result.bookingId).toBe(b1.id); // first in, first promoted

      // Second user should still be waitlisted
      const secondBooking = await db.select().from(bookings).where(eq(bookings.id, b2.id)).get();
      expect(secondBooking?.status).toBe("waitlisted");
    });

    it("clamps credits to 0 when member has insufficient credits", async () => {
      const [user] = await db
        .insert(users)
        .values({ email: "poor@test.com", passwordHash: "h", name: "P", role: "member" })
        .returning();
      const [ms] = await db
        .insert(memberships)
        .values({
          userId: user.id,
          planId: limitedPlanId,
          startDate: "2026-01-01",
          endDate: "2099-01-01",
          creditsRemaining: 1, // less than creditCost of 3
        })
        .returning();
      const [cls] = await db
        .insert(classes)
        .values({
          name: "Yoga",
          room: "A",
          capacity: 1,
          startsAt: new Date(Date.now() + 24 * 3600000).toISOString(),
          creditCost: 3,
        })
        .returning();
      await db
        .insert(bookings)
        .values({
          classId: cls.id,
          userId: user.id,
          membershipId: ms.id,
          status: "waitlisted",
          creditsUsed: 0,
        });

      const result = await WaitlistService.promoteNextFromWaitlist(typedDb, cls.id, cls.creditCost);
      expect(result.promoted).toBe(true);

      // Booking is still promoted
      const updatedMs = await db.select().from(memberships).where(eq(memberships.id, ms.id)).get();
      expect(updatedMs?.creditsRemaining).toBe(0); // Math.max(0, 1 - 3) = 0
    });

    it("skips credit deduction for unlimited memberships", async () => {
      const [unlimitedPlan] = await db
        .insert(membershipPlans)
        .values({ name: "Unlimited", priceCents: 100, durationDays: 30, classCredits: 999 })
        .returning();
      const [user] = await db
        .insert(users)
        .values({ email: "unlimited@test.com", passwordHash: "h", name: "U", role: "member" })
        .returning();
      const [ms] = await db
        .insert(memberships)
        .values({
          userId: user.id,
          planId: unlimitedPlan.id,
          startDate: "2026-01-01",
          endDate: "2099-01-01",
          creditsRemaining: 999,
        })
        .returning();
      const [cls] = await db
        .insert(classes)
        .values({
          name: "Yoga",
          room: "A",
          capacity: 1,
          startsAt: new Date(Date.now() + 24 * 3600000).toISOString(),
          creditCost: 1,
        })
        .returning();
      await db
        .insert(bookings)
        .values({
          classId: cls.id,
          userId: user.id,
          membershipId: ms.id,
          status: "waitlisted",
          creditsUsed: 0,
        });

      await WaitlistService.promoteNextFromWaitlist(typedDb, cls.id, cls.creditCost);

      const updatedMs = await db.select().from(memberships).where(eq(memberships.id, ms.id)).get();
      expect(updatedMs?.creditsRemaining).toBe(999); // Not decremented
    });

    it("skips credit deduction when booking has no membershipId", async () => {
      const [user] = await db
        .insert(users)
        .values({ email: "nomem@test.com", passwordHash: "h", name: "N", role: "member" })
        .returning();
      const [cls] = await db
        .insert(classes)
        .values({
          name: "Yoga",
          room: "A",
          capacity: 1,
          startsAt: new Date(Date.now() + 24 * 3600000).toISOString(),
          creditCost: 1,
        })
        .returning();
      await db
        .insert(bookings)
        .values({
          classId: cls.id,
          userId: user.id,
          membershipId: null,
          status: "waitlisted",
          creditsUsed: 0,
        });

      // Should not throw even with null membershipId
      const result = await WaitlistService.promoteNextFromWaitlist(typedDb, cls.id, cls.creditCost);
      expect(result.promoted).toBe(true);
    });
  });

  // ───────────────────────────────────────────────
  // Corporate booking promotion
  // ───────────────────────────────────────────────

  describe("promoteNextCorporateFromWaitlist", () => {
    it("returns promoted:false when corporate waitlist is empty", async () => {
      const [cls] = await db
        .insert(classes)
        .values({
          name: "Yoga",
          room: "A",
          capacity: 1,
          startsAt: new Date(Date.now() + 24 * 3600000).toISOString(),
        })
        .returning();

      const result = await WaitlistService.promoteNextCorporateFromWaitlist(typedDb, cls.id, 1);
      expect(result.promoted).toBe(false);
    });

    it("promotes a corporate waitlisted member and deducts from company pool", async () => {
      const [user] = await db
        .insert(users)
        .values({ email: "corp@test.com", passwordHash: "h", name: "C", role: "member" })
        .returning();
      const [company] = await db
        .insert(companies)
        .values({ name: "Corp Inc", contactEmail: "corp@inc.com", creditPoolBalance: 20 })
        .returning();
      await db
        .insert(companyMembers)
        .values({ userId: user.id, companyId: company.id });
      const [cls] = await db
        .insert(classes)
        .values({
          name: "Yoga",
          room: "A",
          capacity: 1,
          startsAt: new Date(Date.now() + 24 * 3600000).toISOString(),
          creditCost: 2,
        })
        .returning();
      const [cb] = await db
        .insert(corporateBookings)
        .values({
          classId: cls.id,
          userId: user.id,
          companyId: company.id,
          status: "waitlisted",
          creditsUsed: 0,
        })
        .returning();

      const result = await WaitlistService.promoteNextCorporateFromWaitlist(typedDb, cls.id, cls.creditCost);

      expect(result.promoted).toBe(true);
      expect(result.bookingId).toBe(cb.id);

      const updatedCb = await db.select().from(corporateBookings).where(eq(corporateBookings.id, cb.id)).get();
      expect(updatedCb?.status).toBe("booked");
      expect(updatedCb?.creditsUsed).toBe(2);

      const updatedCompany = await db.select().from(companies).where(eq(companies.id, company.id)).get();
      expect(updatedCompany?.creditPoolBalance).toBe(18); // 20 - 2
    });

    it("promotes but skips deduction when company has insufficient credits", async () => {
      const [user] = await db
        .insert(users)
        .values({ email: "corp2@test.com", passwordHash: "h", name: "C2", role: "member" })
        .returning();
      const [company] = await db
        .insert(companies)
        .values({ name: "Broke Corp", contactEmail: "broke@inc.com", creditPoolBalance: 1 })
        .returning();
      const [cls] = await db
        .insert(classes)
        .values({
          name: "Yoga",
          room: "A",
          capacity: 1,
          startsAt: new Date(Date.now() + 24 * 3600000).toISOString(),
          creditCost: 3,
        })
        .returning();
      await db
        .insert(corporateBookings)
        .values({
          classId: cls.id,
          userId: user.id,
          companyId: company.id,
          status: "waitlisted",
          creditsUsed: 0,
        });

      const result = await WaitlistService.promoteNextCorporateFromWaitlist(typedDb, cls.id, cls.creditCost);
      expect(result.promoted).toBe(true);

      // Booking promoted but company credits unchanged (guard: balance >= cost)
      const updatedCompany = await db.select().from(companies).where(eq(companies.id, company.id)).get();
      expect(updatedCompany?.creditPoolBalance).toBe(1); // Not deducted
    });
  });

  // ───────────────────────────────────────────────
  // Integration: promotion via router cancellation
  // ───────────────────────────────────────────────

  describe("integration: promotion after cancellation via router", () => {
    it("promotes waitlisted user when confirmed booking is cancelled", async () => {
      const [booker] = await db
        .insert(users)
        .values({ email: "booker@test.com", passwordHash: "h", name: "Booker", role: "member" })
        .returning();
      const [bookerMs] = await db
        .insert(memberships)
        .values({
          userId: booker.id,
          planId: limitedPlanId,
          startDate: "2026-01-01",
          endDate: "2099-01-01",
          creditsRemaining: 10,
        })
        .returning();

      const [waiter] = await db
        .insert(users)
        .values({ email: "waiter@test.com", passwordHash: "h", name: "Waiter", role: "member" })
        .returning();
      const [waiterMs] = await db
        .insert(memberships)
        .values({
          userId: waiter.id,
          planId: limitedPlanId,
          startDate: "2026-01-01",
          endDate: "2099-01-01",
          creditsRemaining: 10,
        })
        .returning();

      const [cls] = await db
        .insert(classes)
        .values({
          name: "Yoga",
          room: "A",
          capacity: 1,
          startsAt: new Date(Date.now() + 24 * 3600000).toISOString(),
          creditCost: 1,
        })
        .returning();

      // Booker books (confirmed)
      const bookerCaller = appRouter.createCaller({
        db,
        user: { id: booker.id, role: "member", name: "Booker", email: "booker@test.com" },
      });
      const booking = await bookerCaller.bookings.book({ classId: cls.id });

      // Waiter books (waitlisted because capacity=1)
      const waiterCaller = appRouter.createCaller({
        db,
        user: { id: waiter.id, role: "member", name: "Waiter", email: "waiter@test.com" },
      });
      const waitlistBooking = await waiterCaller.bookings.book({ classId: cls.id });
      expect(waitlistBooking.status).toBe("waitlisted");

      // Cancel the booker's booking
      await bookerCaller.bookings.cancel({ bookingId: booking.id });

      // Waiter should now be promoted
      const updatedWaitlist = await db.select().from(bookings).where(eq(bookings.id, waitlistBooking.id)).get();
      expect(updatedWaitlist?.status).toBe("booked");
      expect(updatedWaitlist?.creditsUsed).toBe(1);

      // Waiter's credits should be deducted
      const updatedWaiterMs = await db.select().from(memberships).where(eq(memberships.id, waiterMs.id)).get();
      expect(updatedWaiterMs?.creditsRemaining).toBe(9); // 10 - 1
    });

    it("does not promote when a waitlisted (not confirmed) booking is cancelled", async () => {
      const [booker] = await db
        .insert(users)
        .values({ email: "b@test.com", passwordHash: "h", name: "B", role: "member" })
        .returning();
      const [bookerMs] = await db
        .insert(memberships)
        .values({ userId: booker.id, planId: limitedPlanId, startDate: "2026-01-01", endDate: "2099-01-01", creditsRemaining: 10 })
        .returning();

      const [waiter1] = await db
        .insert(users)
        .values({ email: "w1@test.com", passwordHash: "h", name: "W1", role: "member" })
        .returning();
      const [w1Ms] = await db
        .insert(memberships)
        .values({ userId: waiter1.id, planId: limitedPlanId, startDate: "2026-01-01", endDate: "2099-01-01", creditsRemaining: 10 })
        .returning();

      const [waiter2] = await db
        .insert(users)
        .values({ email: "w2@test.com", passwordHash: "h", name: "W2", role: "member" })
        .returning();
      const [w2Ms] = await db
        .insert(memberships)
        .values({ userId: waiter2.id, planId: limitedPlanId, startDate: "2026-01-01", endDate: "2099-01-01", creditsRemaining: 10 })
        .returning();

      const [cls] = await db
        .insert(classes)
        .values({
          name: "Yoga",
          room: "A",
          capacity: 1,
          startsAt: new Date(Date.now() + 24 * 3600000).toISOString(),
          creditCost: 1,
        })
        .returning();

      // Fill the class
      await db.insert(bookings).values({ classId: cls.id, userId: booker.id, membershipId: bookerMs.id, status: "booked", creditsUsed: 1 });
      // Two waitlisted users
      const [wb1] = await db.insert(bookings).values({ classId: cls.id, userId: waiter1.id, membershipId: w1Ms.id, status: "waitlisted", creditsUsed: 0 }).returning();
      const [wb2] = await db.insert(bookings).values({ classId: cls.id, userId: waiter2.id, membershipId: w2Ms.id, status: "waitlisted", creditsUsed: 0 }).returning();

      // Cancel the waitlisted booking (not the confirmed one)
      const waiter1Caller = appRouter.createCaller({
        db,
        user: { id: waiter1.id, role: "member", name: "W1", email: "w1@test.com" },
      });
      await waiter1Caller.bookings.cancel({ bookingId: wb1.id });

      // Waiter2 should still be waitlisted — cancelling a waitlisted booking does not promote
      const w2Booking = await db.select().from(bookings).where(eq(bookings.id, wb2.id)).get();
      expect(w2Booking?.status).toBe("waitlisted");
    });
  });

  // ───────────────────────────────────────────────
  // PRESERVED BUG: Reschedule does NOT promote
  // ───────────────────────────────────────────────
  // This test exists in reschedules.test.ts as:
  //   "exhibits KNOWN BUG: rescheduling does NOT promote waitlisted user for original class"
  // We add a parallel assertion here for WaitlistService documentation purposes.

  describe("PRESERVED BUG: reschedule does not trigger waitlist promotion", () => {
    it("reschedule cancels original booking but waitlisted users remain waitlisted", async () => {
      const [user] = await db
        .insert(users)
        .values({ email: "r@test.com", passwordHash: "h", name: "R", role: "member" })
        .returning();
      const [ms] = await db
        .insert(memberships)
        .values({
          userId: user.id,
          planId: limitedPlanId,
          startDate: new Date().toISOString().slice(0, 10),
          endDate: new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10),
          creditsRemaining: 9,
        })
        .returning();

      const [cls1] = await db
        .insert(classes)
        .values({
          name: "Yoga",
          room: "A",
          capacity: 1,
          startsAt: new Date(Date.now() + 24 * 3600000).toISOString(),
          creditCost: 1,
        })
        .returning();
      const [cls2] = await db
        .insert(classes)
        .values({
          name: "Yoga",
          room: "B",
          capacity: 10,
          startsAt: new Date(Date.now() + 48 * 3600000).toISOString(),
          creditCost: 1,
        })
        .returning();

      // User books cls1
      const [booking] = await db
        .insert(bookings)
        .values({ classId: cls1.id, userId: user.id, membershipId: ms.id, status: "booked", creditsUsed: 1 })
        .returning();

      // Another user waitlisted on cls1
      const [waiter] = await db
        .insert(users)
        .values({ email: "w@test.com", passwordHash: "h", name: "W", role: "member" })
        .returning();
      const [wMs] = await db
        .insert(memberships)
        .values({ userId: waiter.id, planId: limitedPlanId, startDate: "2026-01-01", endDate: "2099-01-01", creditsRemaining: 10 })
        .returning();
      const [waitlistBooking] = await db
        .insert(bookings)
        .values({ classId: cls1.id, userId: waiter.id, membershipId: wMs.id, status: "waitlisted", creditsUsed: 0 })
        .returning();

      // Reschedule: cls1 → cls2
      const caller = appRouter.createCaller({
        db,
        user: { id: user.id, role: "member", name: "R", email: "r@test.com" },
      });
      await caller.reschedules.reschedule({ fromBookingId: booking.id, toClassId: cls2.id });

      // BUG: Waitlisted user is NOT promoted
      const waitlistAfter = await db.select().from(bookings).where(eq(bookings.id, waitlistBooking.id)).get();
      expect(waitlistAfter?.status).toBe("waitlisted");
    });
  });
});
