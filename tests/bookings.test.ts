import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { getTestDb, clearTestDb, testUser } from "./db";
import {
  users,
  classes,
  bookings,
  memberships,
  membershipPlans,
} from "../src/db/schema";
import { eq } from "drizzle-orm";
import { appRouter } from "../src/server/routers/_app";

describe("Booking Service Baseline", () => {
  const db = getTestDb();
  let userId: number;
  let limitedPlanId: number;
  let membershipId: number;
  let classId: number;

  beforeAll(async () => {
    // any heavy global setup
  });

  beforeEach(async () => {
    await clearTestDb(db);
    
    // Seed test data
    const [user] = await db
      .insert(users)
      .values({
        email: "test@example.com",
        passwordHash: "hash",
        name: "Test User",
        role: "member",
      })
      .returning();
    userId = user.id;

    await db
      .insert(membershipPlans)
      .values({
        name: "Unlimited",
        priceCents: 100,
        durationDays: 30,
        classCredits: 999, // UNLIMITED_CREDITS
      })
      .returning();

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

    const [ms] = await db
      .insert(memberships)
      .values({
        userId,
        planId: limitedPlanId,
        startDate: new Date().toISOString().slice(0, 10),
        endDate: new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10),
        creditsRemaining: 10,
        status: "active",
      })
      .returning();
    membershipId = ms.id;

    const [cls] = await db
      .insert(classes)
      .values({
        name: "Yoga",
        room: "A",
        capacity: 1, // small capacity to test waitlist
        startsAt: new Date(Date.now() + 24 * 3600000).toISOString(), // 24 hours from now
        durationMin: 60,
        creditCost: 1,
      })
      .returning();
    classId = cls.id;
  });

  function memberCaller() {
    return appRouter.createCaller({ db, user: testUser({ id: userId, role: "member", name: "Test User", email: "test@example.com" }), token: undefined });
  }

  it("allows a member to book a class and deducts credits", async () => {
    const result = await memberCaller().bookings.book({ classId });
    
    expect(result.status).toBe("booked");
    expect(result.creditsUsed).toBe(1);

    const ms = await db.select().from(memberships).where(eq(memberships.id, membershipId)).get();
    expect(ms?.creditsRemaining).toBe(9); // 10 - 1 = 9
  });

  it("waitlists a member if class is full and uses 0 credits initially", async () => {
    // Fill the class first
    const [otherUser] = await db.insert(users).values({ email: "other@example.com", passwordHash: "h", name: "O", role: "member" }).returning();
    const [otherMs] = await db.insert(memberships).values({ userId: otherUser.id, planId: limitedPlanId, startDate: "2026-01-01", endDate: "2099-01-01", creditsRemaining: 10 }).returning();
    await db.insert(bookings).values({ classId, userId: otherUser.id, membershipId: otherMs.id, status: "booked", creditsUsed: 1 });

    const result = await memberCaller().bookings.book({ classId });
    
    expect(result.status).toBe("waitlisted");
    expect(result.creditsUsed).toBe(0);

    const ms = await db.select().from(memberships).where(eq(memberships.id, membershipId)).get();
    expect(ms?.creditsRemaining).toBe(10); // 10 - 0 = 10
  });

  it("cancelling a booking refunds credits if > 12h and promotes waitlisted", async () => {
    // Create class > 12h away
    const [cls] = await db
      .insert(classes)
      .values({
        name: "Yoga 2",
        room: "A",
        capacity: 1, 
        startsAt: new Date(Date.now() + 24 * 3600000).toISOString(),
      })
      .returning();

    // User books
    const booking = await memberCaller().bookings.book({ classId: cls.id });
    
    // Other user waitlists
    const [otherUser] = await db.insert(users).values({ email: "other@example.com", passwordHash: "h", name: "O", role: "member" }).returning();
    const [otherMs] = await db.insert(memberships).values({ userId: otherUser.id, planId: limitedPlanId, startDate: "2026-01-01", endDate: "2099-01-01", creditsRemaining: 10 }).returning();
    const otherCaller = appRouter.createCaller({ db, user: testUser({ id: otherUser.id, role: "member", name: "O", email: "o@example.com" }), token: undefined });
    const waitlistBooking = await otherCaller.bookings.book({ classId: cls.id });

    // Cancel first user's booking
    const cancelRes = await memberCaller().bookings.cancel({ bookingId: booking.id });
    expect(cancelRes.refunded).toBe(true);

    const firstUserMs = await db.select().from(memberships).where(eq(memberships.id, membershipId)).get();
    expect(firstUserMs?.creditsRemaining).toBe(10);

    const updatedWaitlist = await db.select().from(bookings).where(eq(bookings.id, waitlistBooking.id)).get();
    expect(updatedWaitlist?.status).toBe("booked");
    expect(updatedWaitlist?.creditsUsed).toBe(1);

    const otherUserMsAfter = await db.select().from(memberships).where(eq(memberships.id, otherMs.id)).get();
    expect(otherUserMsAfter?.creditsRemaining).toBe(9);
  });

  it("rejects booking when member has insufficient credits", async () => {
    await db.update(memberships).set({ creditsRemaining: 0 }).where(eq(memberships.id, membershipId));
    await expect(memberCaller().bookings.book({ classId })).rejects.toThrow("Not enough class credits remaining.");
  });

  it("rejects booking when member has no active membership", async () => {
    await db.update(memberships).set({ status: "expired" }).where(eq(memberships.id, membershipId));
    await expect(memberCaller().bookings.book({ classId })).rejects.toThrow("An active membership is required to book classes.");
  });

  it("prevents duplicate bookings for the same class", async () => {
    await memberCaller().bookings.book({ classId });
    await expect(memberCaller().bookings.book({ classId })).rejects.toThrow("You are already on the list for this class.");
  });

  it("does not deduct credits for unlimited membership (999)", async () => {
    await db.update(memberships).set({ creditsRemaining: 999 }).where(eq(memberships.id, membershipId));

    const result = await memberCaller().bookings.book({ classId });

    expect(result.status).toBe("booked");
    expect(result.creditsUsed).toBe(1);

    // Credits should remain at 999 (unlimited never decrements)
    const ms = await db.select().from(memberships).where(eq(memberships.id, membershipId)).get();
    expect(ms?.creditsRemaining).toBe(999);
  });

  it("forfeits credits when cancelling inside the 12-hour window", async () => {
    // Create class only 6 hours away (inside the 12-hour window)
    const [nearCls] = await db
      .insert(classes)
      .values({
        name: "Yoga Near",
        room: "A",
        capacity: 10,
        startsAt: new Date(Date.now() + 6 * 3600000).toISOString(), // 6 hours away
        durationMin: 60,
        creditCost: 1,
      })
      .returning();

    const booking = await memberCaller().bookings.book({ classId: nearCls.id });
    expect(booking.creditsUsed).toBe(1);

    // Credits now 9
    const msBefore = await db.select().from(memberships).where(eq(memberships.id, membershipId)).get();
    expect(msBefore?.creditsRemaining).toBe(9);

    // Cancel inside window - should NOT refund
    const cancelRes = await memberCaller().bookings.cancel({ bookingId: booking.id });
    expect(cancelRes.refunded).toBe(false);

    // Credits should remain at 9 (no refund)
    const msAfter = await db.select().from(memberships).where(eq(memberships.id, membershipId)).get();
    expect(msAfter?.creditsRemaining).toBe(9);
  });

  it("staff (trainer) can cancel another member's booking", async () => {
    const [trainer] = await db.insert(users).values({ email: "trainer@test.com", passwordHash: "h", name: "T", role: "trainer" }).returning();

    const booking = await memberCaller().bookings.book({ classId });

    const trainerCaller = appRouter.createCaller({ db, user: testUser({ id: trainer.id, role: "trainer", name: "T", email: "trainer@test.com" }), token: undefined });
    const cancelRes = await trainerCaller.bookings.cancel({ bookingId: booking.id });
    expect(cancelRes.ok).toBe(true);

    const b = await db.select().from(bookings).where(eq(bookings.id, booking.id)).get();
    expect(b?.status).toBe("cancelled");
  });
});
