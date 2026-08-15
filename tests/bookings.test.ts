import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { getTestDb, clearTestDb } from "./db";
import {
  users,
  classes,
  bookings,
  memberships,
  membershipPlans,
} from "../src/db/schema";
import { and, eq } from "drizzle-orm";
import { appRouter } from "../src/server/routers/_app";

describe("Booking Service Baseline", () => {
  const db = getTestDb();
  let userId: number;
  let memberId: number;
  let unlimitedPlanId: number;
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

    const [unlimitedPlan] = await db
      .insert(membershipPlans)
      .values({
        name: "Unlimited",
        priceCents: 100,
        durationDays: 30,
        classCredits: 999, // UNLIMITED_CREDITS
      })
      .returning();
    unlimitedPlanId = unlimitedPlan.id;

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

  it("allows a member to book a class and deducts credits", async () => {
    // Use tRPC caller directly
    const caller = appRouter.createCaller({ db: db as any, user: { id: userId, role: "member", name: "Test User", email: "test@example.com" } as any } as any);
    
    const result = await caller.bookings.book({ classId });
    
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

    const caller = appRouter.createCaller({ db: db as any, user: { id: userId, role: "member", name: "Test User", email: "test@example.com" } as any } as any);
    
    const result = await caller.bookings.book({ classId });
    
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
    const caller = appRouter.createCaller({ db: db as any, user: { id: userId, role: "member", name: "Test User", email: "test@example.com" } as any } as any);
    const booking = await caller.bookings.book({ classId: cls.id });
    
    // Other user waitlists
    const [otherUser] = await db.insert(users).values({ email: "other@example.com", passwordHash: "h", name: "O", role: "member" }).returning();
    const [otherMs] = await db.insert(memberships).values({ userId: otherUser.id, planId: limitedPlanId, startDate: "2026-01-01", endDate: "2099-01-01", creditsRemaining: 10 }).returning();
    const otherCaller = appRouter.createCaller({ db: db as any, user: { id: otherUser.id, role: "member", name: "O", email: "o@example.com" } as any } as any);
    const waitlistBooking = await otherCaller.bookings.book({ classId: cls.id });

    // Cancel first user's booking
    const cancelRes = await caller.bookings.cancel({ bookingId: booking.id });
    expect(cancelRes.refunded).toBe(true);

    const firstUserMs = await db.select().from(memberships).where(eq(memberships.id, membershipId)).get();
    expect(firstUserMs?.creditsRemaining).toBe(10);

    const updatedWaitlist = await db.select().from(bookings).where(eq(bookings.id, waitlistBooking.id)).get();
    expect(updatedWaitlist?.status).toBe("booked");
    expect(updatedWaitlist?.creditsUsed).toBe(1);

    const otherUserMsAfter = await db.select().from(memberships).where(eq(memberships.id, otherMs.id)).get();
    expect(otherUserMsAfter?.creditsRemaining).toBe(9);
  });
});
