import { eq } from "drizzle-orm";
import { payments } from "@/db/schema";
import { MembershipService } from "./MembershipService";

export class PaymentService {
  /**
   * Creates a payment record.
   */
  static async createPayment(
    db: any,
    userId: number,
    membershipId: number,
    amountCents: number,
    method: string,
  ) {
    return db
      .insert(payments)
      .values({
        userId,
        membershipId,
        amountCents,
        method,
        status: "paid",
        reference: `PAY-${Date.now()}`,
      })
      .returning()
      .get();
  }

  /**
   * Marks a payment as paid.
   */
  static async markPaid(db: any, paymentId: number) {
    return db
      .update(payments)
      .set({ status: "paid" })
      .where(eq(payments.id, paymentId))
      .returning()
      .get();
  }

  /**
   * Refunds a payment. Also cancels the associated membership if present.
   * Expects to be called within a database transaction.
   */
  static async refundPayment(db: any, payment: any) {
    const updated = await db
      .update(payments)
      .set({ status: "refunded" })
      .where(eq(payments.id, payment.id))
      .returning()
      .get();

    if (payment.membershipId) {
      await MembershipService.cancelMembership(db, payment.membershipId);
    }

    return updated;
  }
}
