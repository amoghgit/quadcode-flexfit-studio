import { describe, it, expect, beforeEach } from "vitest";
import { getTestDb, clearTestDb } from "./db";
import { users, memberships, membershipPlans, payments } from "../src/db/schema";
import { PaymentService } from "../src/server/services/PaymentService";
import { eq } from "drizzle-orm";
import { appRouter } from "../src/server/routers/_app";

describe("PaymentService", () => {
  const db = getTestDb();
  let userId: number;
  let planId: number;
  let membershipId: number;

  beforeEach(async () => {
    await clearTestDb(db);
    const [user] = await db
      .insert(users)
      .values({ email: "pay@example.com", passwordHash: "h", name: "Pay", role: "member" })
      .returning();
    userId = user.id;

    const [plan] = await db
      .insert(membershipPlans)
      .values({ name: "Plan", priceCents: 100, durationDays: 30, classCredits: 10 })
      .returning();
    planId = plan.id;

    const [ms] = await db.insert(memberships).values({
      userId, planId, startDate: "2099-01-01", endDate: "2099-01-30", creditsRemaining: 10, status: "active"
    }).returning();
    membershipId = ms.id;
  });

  it("createPayment works", async () => {
    const p = await PaymentService.createPayment(db, userId, membershipId, 100, "card");
    expect(p.status).toBe("paid");
    expect(p.amountCents).toBe(100);
  });

  it("refundPayment refunds payment and cancels membership", async () => {
    const p = await PaymentService.createPayment(db, userId, membershipId, 100, "card");
    await PaymentService.refundPayment(db, p);

    const ms = await db.select().from(memberships).where(eq(memberships.id, membershipId)).get();
    expect(ms?.status).toBe("cancelled");

    const updatedP = await db.select().from(payments).where(eq(payments.id, p.id)).get();
    expect(updatedP?.status).toBe("refunded");
  });

  it("admin can refund via router", async () => {
    const p = await PaymentService.createPayment(db, userId, membershipId, 100, "card");
    
    // Auth correctly
    const caller = appRouter.createCaller({ db: db as any, user: { id: 99, role: "admin", name: "Admin", email: "admin@example.com" } as any } as any);
    await caller.payments.refund({ id: p.id });

    const updatedP = await db.select().from(payments).where(eq(payments.id, p.id)).get();
    expect(updatedP?.status).toBe("refunded");
    
    const ms = await db.select().from(memberships).where(eq(memberships.id, membershipId)).get();
    expect(ms?.status).toBe("cancelled");
  });
  
  it("non-admin cannot refund via router", async () => {
    const p = await PaymentService.createPayment(db, userId, membershipId, 100, "card");
    const caller = appRouter.createCaller({ db: db as any, user: { id: userId, role: "member", name: "Pay", email: "pay@example.com" } as any } as any);
    
    await expect(caller.payments.refund({ id: p.id })).rejects.toThrow();
  });
});
