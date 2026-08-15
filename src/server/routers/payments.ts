import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { desc, eq } from "drizzle-orm";
import { payments, users, memberships, membershipPlans } from "@/db/schema";
import { router, protectedProcedure, adminProcedure } from "../trpc";
import { PaymentService } from "../services/PaymentService";

export const paymentsRouter = router({
  mine: protectedProcedure.query(async ({ ctx }) => {
    return ctx.db
      .select({
        id: payments.id,
        amountCents: payments.amountCents,
        method: payments.method,
        status: payments.status,
        reference: payments.reference,
        createdAt: payments.createdAt,
        planName: membershipPlans.name,
      })
      .from(payments)
      .leftJoin(memberships, eq(payments.membershipId, memberships.id))
      .leftJoin(membershipPlans, eq(memberships.planId, membershipPlans.id))
      .where(eq(payments.userId, ctx.user.id))
      .orderBy(desc(payments.createdAt));
  }),

  all: adminProcedure
    .input(z.object({ limit: z.number().default(100) }).default({}))
    .query(async ({ ctx, input }) => {
      return ctx.db
        .select({
          id: payments.id,
          amountCents: payments.amountCents,
          method: payments.method,
          status: payments.status,
          reference: payments.reference,
          createdAt: payments.createdAt,
          memberName: users.name,
          memberEmail: users.email,
        })
        .from(payments)
        .innerJoin(users, eq(payments.userId, users.id))
        .orderBy(desc(payments.createdAt))
        .limit(input.limit);
    }),

  markPaid: adminProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const row = await ctx.db
        .select()
        .from(payments)
        .where(eq(payments.id, input.id))
        .get();

      if (!row) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Payment not found." });
      }
      if (row.status === "refunded") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Refunded payments cannot be marked paid.",
        });
      }

      return PaymentService.markPaid(ctx.db, input.id);
    }),

  refund: adminProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const row = await ctx.db
        .select()
        .from(payments)
        .where(eq(payments.id, input.id))
        .get();

      if (!row) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Payment not found." });
      }
      if (row.status !== "paid") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Only paid payments can be refunded.",
        });
      }

      return ctx.db.transaction(async (tx: any) => {
        return PaymentService.refundPayment(tx, row);
      });
    }),
});
