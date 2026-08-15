import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { getTestDb, clearTestDb } from "./db";
import {
  users,
  classes,
  bookings,
  memberships,
  membershipPlans,
  reschedules,
} from "../src/db/schema";
import { and, eq } from "drizzle-orm";
import { appRouter } from "../src/server/routers/_app";

describe("Reschedule Service Baseline", () => {
  const db = getTestDb();
  let userId: number;
  let limitedPlanId: number;
  let membershipId: number;
  let originalClassId: number;
  let newClassId: number;
  let originalBookingId: number;

  beforeEach(async () => {
    await clearTestDb(db);
    
    // Seed test data
    const [user] = await db
      .insert(users)
      .values({ email: "ruser@test.com", passwordHash: "h", name: "R User", role: "member" })
      .returning();
    userId = user.id;

    const [limitedPlan] = await db
      .insert(membershipPlans)
      .values({ name: "Drop-in", priceCents: 50, durationDays: 30, classCredits: 10 })
      .returning();
    limitedPlanId = limitedPlan.id;

    const [ms] = await db
      .insert(memberships)
      .values({
        userId,
        planId: limitedPlanId,
        startDate: new Date().toISOString().slice(0, 10),
        endDate: new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10),
        creditsRemaining: 9, // already used 1
        status: "active",
      })
      .returning();
    membershipId = ms.id;

    const [cls1] = await db
      .insert(classes)
      .values({
        name: "Yoga",
        room: "A",
        capacity: 1, 
        startsAt: new Date(Date.now() + 24 * 3600000).toISOString(), 
        durationMin: 60,
        creditCost: 1,
      })
      .returning();
    originalClassId = cls1.id;

    const [cls2] = await db
      .insert(classes)
      .values({
        name: "Yoga", // must match
        room: "B",
        capacity: 10, 
        startsAt: new Date(Date.now() + 48 * 3600000).toISOString(), 
        durationMin: 60,
        creditCost: 1,
      })
      .returning();
    newClassId = cls2.id;

    const [booking] = await db
      .insert(bookings)
      .values({
        classId: originalClassId,
        userId,
        membershipId,
        status: "booked",
        creditsUsed: 1,
      })
      .returning();
    originalBookingId = booking.id;
  });

  it("reschedules free of charge and carries over creditsUsed", async () => {
    const caller = appRouter.createCaller({ db, user: { id: userId, role: "member", name: "R", email: "r@test.com" } });
    const res = await caller.reschedules.reschedule({ fromBookingId: originalBookingId, toClassId: newClassId });
    
    expect(res.ok).toBe(true);
    expect(res.newStatus).toBe("booked");
    
    // Check old booking
    const oldB = await db.select().from(bookings).where(eq(bookings.id, originalBookingId)).get();
    expect(oldB?.status).toBe("cancelled");
    
    // Check new booking
    const newB = await db.select().from(bookings).where(eq(bookings.id, res.newBooking.id)).get();
    expect(newB?.status).toBe("booked");
    expect(newB?.creditsUsed).toBe(1); // kept the 1 credit
    
    // Check memberships (no additional deduction)
    const ms = await db.select().from(memberships).where(eq(memberships.id, membershipId)).get();
    expect(ms?.creditsRemaining).toBe(9);
  });

  it("exhibits KNOWN BUG: rescheduling does NOT promote waitlisted user for original class", async () => {
    // waitlist another user on originalClass
    const [otherUser] = await db.insert(users).values({ email: "ow@test.com", passwordHash: "h", name: "W", role: "member" }).returning();
    const [otherMs] = await db.insert(memberships).values({ userId: otherUser.id, planId: limitedPlanId, startDate: "2026", endDate: "2099", creditsRemaining: 10 }).returning();
    
    const [waitlistB] = await db.insert(bookings).values({
      classId: originalClassId,
      userId: otherUser.id,
      membershipId: otherMs.id,
      status: "waitlisted",
      creditsUsed: 0,
    }).returning();

    const caller = appRouter.createCaller({ db, user: { id: userId, role: "member", name: "R", email: "r@test.com" } });
    await caller.reschedules.reschedule({ fromBookingId: originalBookingId, toClassId: newClassId });
    
    // Check waitlisted user - SHOULD still be waitlisted because of the bug
    const waitlistUser = await db.select().from(bookings).where(eq(bookings.id, waitlistB.id)).get();
    
    expect(waitlistUser?.status).toBe("waitlisted"); // The bug is preserved
  });
});
