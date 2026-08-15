import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { membershipPlans, memberships, payments } from "@/db/schema";
import { router, publicProcedure, protectedProcedure, adminProcedure } from "../trpc";
import { MembershipService } from "../services/MembershipService";
import { PaymentService } from "../services/PaymentService";

export const plansRouter = router({
  list: publicProcedure
    .input(z.object({ includeInactive: z.boolean().default(false) }).default({}))
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db.select().from(membershipPlans);
      return input.includeInactive ? rows : rows.filter((p) => p.active);
    }),

  subscribe: protectedProcedure
    .input(
      z.object({
        planId: z.number(),
        method: z.enum(["card", "cash", "upi", "transfer"]).default("card"),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const plan = await ctx.db
        .select()
        .from(membershipPlans)
        .where(eq(membershipPlans.id, input.planId))
        .get();

      if (!plan) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Plan not found." });
      }
      if (!plan.active) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "This plan is no longer available.",
        });
      }

      return ctx.db.transaction(async (tx: any) => {
        const membership = await MembershipService.createMembership(
          tx,
          ctx.user.id,
          plan,
        );

        await PaymentService.createPayment(
          tx,
          ctx.user.id,
          membership.id,
          plan.priceCents,
          input.method,
        );

        return membership;
      });
    }),

  create: adminProcedure
    .input(
      z.object({
        name: z.string().min(1),
        description: z.string().optional(),
        priceCents: z.number().int().nonnegative(),
        durationDays: z.number().int().positive(),
        classCredits: z.number().int().nonnegative().default(0),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return ctx.db
        .insert(membershipPlans)
        .values({ ...input, description: input.description ?? null })
        .returning()
        .get();
    }),

  setActive: adminProcedure
    .input(z.object({ id: z.number(), active: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      return ctx.db
        .update(membershipPlans)
        .set({ active: input.active })
        .where(eq(membershipPlans.id, input.id))
        .returning()
        .get();
    }),
});
