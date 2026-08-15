import { and, desc, eq, sql } from "drizzle-orm";
import { memberships } from "@/db/schema";
import { UNLIMITED_CREDITS } from "../routers/bookings";

function addDays(dateIso: string, days: number): string {
  const d = new Date(dateIso);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

export class MembershipService {
  /**
   * Finds the user's current active membership.
   */
  static async getActiveMembership(db: any, userId: number) {
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

  /**
   * Creates a new membership based on a plan.
   */
  static async createMembership(db: any, userId: number, plan: any) {
    const today = new Date().toISOString().slice(0, 10);
    return db
      .insert(memberships)
      .values({
        userId,
        planId: plan.id,
        startDate: today,
        endDate: addDays(today, plan.durationDays),
        creditsRemaining: plan.classCredits,
        status: "active",
      })
      .returning()
      .get();
  }

  /**
   * Cancels a membership.
   */
  static async cancelMembership(db: any, membershipId: number) {
    return db
      .update(memberships)
      .set({ status: "cancelled" })
      .where(eq(memberships.id, membershipId))
      .returning()
      .get();
  }

  /**
   * Checks if a membership has enough credits.
   */
  static hasEnoughCredits(membership: { creditsRemaining: number }, cost: number): boolean {
    if (membership.creditsRemaining >= UNLIMITED_CREDITS) return true;
    return membership.creditsRemaining >= cost;
  }

  /**
   * Deducts credits from a membership, honoring the UNLIMITED_CREDITS logic.
   */
  static async consumeCredits(db: any, membershipId: number, currentCredits: number, cost: number) {
    if (currentCredits >= UNLIMITED_CREDITS) {
      return;
    }
    await db
      .update(memberships)
      .set({ creditsRemaining: currentCredits - cost })
      .where(eq(memberships.id, membershipId));
  }

  /**
   * Refunds credits to a membership, honoring the UNLIMITED_CREDITS logic.
   */
  static async refundCredits(db: any, membershipId: number, currentCredits: number, amount: number) {
    if (currentCredits >= UNLIMITED_CREDITS) {
      return;
    }
    await db
      .update(memberships)
      .set({ creditsRemaining: currentCredits + amount })
      .where(eq(memberships.id, membershipId));
  }
}
