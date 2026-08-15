import { describe, it, expect, beforeEach } from "vitest";
import { getTestDb, clearTestDb } from "./db";
import { users, memberships, membershipPlans } from "../src/db/schema";
import { MembershipService } from "../src/server/services/MembershipService";

describe("MembershipService", () => {
  const db = getTestDb();
  let userId: number;
  let planId: number;

  beforeEach(async () => {
    await clearTestDb(db);
    const [user] = await db
      .insert(users)
      .values({ email: "mem@example.com", passwordHash: "h", name: "Mem", role: "member" })
      .returning();
    userId = user.id;

    const [plan] = await db
      .insert(membershipPlans)
      .values({ name: "Plan", priceCents: 100, durationDays: 30, classCredits: 10 })
      .returning();
    planId = plan.id;
  });

  it("getActiveMembership finds active membership", async () => {
    await db.insert(memberships).values({
      userId,
      planId,
      startDate: new Date().toISOString().slice(0, 10),
      endDate: new Date(Date.now() + 86400000 * 30).toISOString().slice(0, 10),
      creditsRemaining: 10,
      status: "active",
    });

    const ms = await MembershipService.getActiveMembership(db, userId);
    expect(ms).toBeDefined();
    expect(ms?.creditsRemaining).toBe(10);
  });

  it("getActiveMembership ignores expired membership", async () => {
    await db.insert(memberships).values({
      userId,
      planId,
      startDate: "2000-01-01",
      endDate: "2000-01-30",
      creditsRemaining: 10,
      status: "active",
    });

    const ms = await MembershipService.getActiveMembership(db, userId);
    expect(ms).toBeUndefined();
  });

  it("checkCredits handles insufficient credits", () => {
    expect(MembershipService.hasEnoughCredits({ creditsRemaining: 0 }, 1)).toBe(false);
    expect(MembershipService.hasEnoughCredits({ creditsRemaining: 5 }, 10)).toBe(false);
  });

  it("checkCredits handles unlimited credits", () => {
    expect(MembershipService.hasEnoughCredits({ creditsRemaining: 999 }, 1000)).toBe(true);
  });

  it("consumeCredits deducts credits", async () => {
    const [ms] = await db.insert(memberships).values({
      userId, planId, startDate: "2099-01-01", endDate: "2099-01-30", creditsRemaining: 10, status: "active"
    }).returning();

    await MembershipService.consumeCredits(db, ms.id, 10, 2);
    const updated = await MembershipService.getActiveMembership(db, userId);
    expect(updated?.creditsRemaining).toBe(8);
  });

  it("consumeCredits ignores unlimited credits", async () => {
    const [ms] = await db.insert(memberships).values({
      userId, planId, startDate: "2099-01-01", endDate: "2099-01-30", creditsRemaining: 999, status: "active"
    }).returning();

    await MembershipService.consumeCredits(db, ms.id, 999, 1);
    const updated = await MembershipService.getActiveMembership(db, userId);
    expect(updated?.creditsRemaining).toBe(999);
  });

  it("refundCredits restores credits", async () => {
    const [ms] = await db.insert(memberships).values({
      userId, planId, startDate: "2099-01-01", endDate: "2099-01-30", creditsRemaining: 5, status: "active"
    }).returning();

    await MembershipService.refundCredits(db, ms.id, 5, 2);
    const updated = await MembershipService.getActiveMembership(db, userId);
    expect(updated?.creditsRemaining).toBe(7);
  });

  it("refundCredits ignores unlimited credits", async () => {
    const [ms] = await db.insert(memberships).values({
      userId, planId, startDate: "2099-01-01", endDate: "2099-01-30", creditsRemaining: 999, status: "active"
    }).returning();

    await MembershipService.refundCredits(db, ms.id, 999, 5);
    const updated = await MembershipService.getActiveMembership(db, userId);
    expect(updated?.creditsRemaining).toBe(999);
  });
});
