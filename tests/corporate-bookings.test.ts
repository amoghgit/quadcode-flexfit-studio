import { describe, it, expect, beforeEach } from "vitest";
import { getTestDb, clearTestDb } from "./db";
import { appRouter } from "../src/server/routers/_app";
import {
  users,
  classes,
  corporateBookings,
  companies,
  companyMembers,
  checkins,
} from "../src/db/schema";
import { eq } from "drizzle-orm";

describe("Corporate Bookings", () => {
  const db = getTestDb();
  
  beforeEach(async () => {
    await clearTestDb(db);
  });

  async function setupCorporateEnv(credits = 10) {
    const [user] = await db
      .insert(users)
      .values({ email: "corp@test.com", passwordHash: "h", name: "CorpUser", role: "member" })
      .returning();
    const [company] = await db
      .insert(companies)
      .values({ name: "Acme Corp", contactEmail: "admin@acme.com", creditPoolBalance: credits })
      .returning();
    await db
      .insert(companyMembers)
      .values({ userId: user.id, companyId: company.id });
    
    return { user, company };
  }

  describe("book", () => {
    it("books a class and deducts company credits", async () => {
      const { user, company } = await setupCorporateEnv(10);
      const [cls] = await db
        .insert(classes)
        .values({
          name: "Yoga",
          room: "A",
          capacity: 10,
          startsAt: new Date(Date.now() + 48 * 3600000).toISOString(),
          creditCost: 2,
        })
        .returning();

      const caller = appRouter.createCaller({
        db,
        user: { id: user.id, role: "member", name: user.name, email: user.email },
      } as any);

      const booking = await caller.corporateBookings.book({ classId: cls.id });
      
      expect(booking.status).toBe("booked");
      expect(booking.creditsUsed).toBe(2);

      const updatedCompany = await db.select().from(companies).where(eq(companies.id, company.id)).get();
      expect(updatedCompany?.creditPoolBalance).toBe(8);
    });

    it("throws FORBIDDEN when company has insufficient credits", async () => {
      const { user } = await setupCorporateEnv(1);
      const [cls] = await db
        .insert(classes)
        .values({
          name: "Yoga",
          room: "A",
          capacity: 10,
          startsAt: new Date(Date.now() + 48 * 3600000).toISOString(),
          creditCost: 2,
        })
        .returning();

      const caller = appRouter.createCaller({
        db,
        user: { id: user.id, role: "member", name: user.name, email: user.email },
      } as any);

      await expect(caller.corporateBookings.book({ classId: cls.id }))
        .rejects.toThrow(/Your company does not have enough credits/);
    });

    it("places user on waitlist if class is full and charges 0 credits", async () => {
      const { user, company } = await setupCorporateEnv(10);
      
      const [cls] = await db
        .insert(classes)
        .values({
          name: "Yoga",
          room: "A",
          capacity: 1,
          startsAt: new Date(Date.now() + 48 * 3600000).toISOString(),
          creditCost: 2,
        })
        .returning();

      // fill the class
      const [otherUser] = await db
        .insert(users)
        .values({ email: "other@test.com", passwordHash: "h", name: "Other", role: "member" })
        .returning();
      await db.insert(corporateBookings).values({
        classId: cls.id,
        userId: otherUser.id,
        companyId: company.id,
        status: "booked",
        creditsUsed: 2,
      });

      const caller = appRouter.createCaller({
        db,
        user: { id: user.id, role: "member", name: user.name, email: user.email },
      } as any);

      const booking = await caller.corporateBookings.book({ classId: cls.id });
      
      expect(booking.status).toBe("waitlisted");
      expect(booking.creditsUsed).toBe(0);

      const updatedCompany = await db.select().from(companies).where(eq(companies.id, company.id)).get();
      expect(updatedCompany?.creditPoolBalance).toBe(10); // Not deducted for waitlist
    });
  });

  describe("cancel", () => {
    it("refunds credits when cancelling outside the 24-hour window", async () => {
      const { user, company } = await setupCorporateEnv(10);
      const [cls] = await db
        .insert(classes)
        .values({
          name: "Yoga",
          room: "A",
          capacity: 10,
          startsAt: new Date(Date.now() + 48 * 3600000).toISOString(),
          creditCost: 2,
        })
        .returning();

      const [booking] = await db.insert(corporateBookings).values({
        classId: cls.id,
        userId: user.id,
        companyId: company.id,
        status: "booked",
        creditsUsed: 2,
      }).returning();

      await db.update(companies).set({ creditPoolBalance: 8 }).where(eq(companies.id, company.id));

      const caller = appRouter.createCaller({
        db,
        user: { id: user.id, role: "member", name: user.name, email: user.email },
      } as any);

      const res = await caller.corporateBookings.cancel({ bookingId: booking.id });
      expect(res.refunded).toBe(true);

      const updatedCompany = await db.select().from(companies).where(eq(companies.id, company.id)).get();
      expect(updatedCompany?.creditPoolBalance).toBe(10); // Refunded
    });

    it("forfeits credits when cancelling within the 24-hour window", async () => {
      const { user, company } = await setupCorporateEnv(10);
      const [cls] = await db
        .insert(classes)
        .values({
          name: "Yoga",
          room: "A",
          capacity: 10,
          startsAt: new Date(Date.now() + 12 * 3600000).toISOString(), // 12 hours from now
          creditCost: 2,
        })
        .returning();

      const [booking] = await db.insert(corporateBookings).values({
        classId: cls.id,
        userId: user.id,
        companyId: company.id,
        status: "booked",
        creditsUsed: 2,
      }).returning();

      await db.update(companies).set({ creditPoolBalance: 8 }).where(eq(companies.id, company.id));

      const caller = appRouter.createCaller({
        db,
        user: { id: user.id, role: "member", name: user.name, email: user.email },
      } as any);

      const res = await caller.corporateBookings.cancel({ bookingId: booking.id });
      expect(res.refunded).toBe(false);

      const updatedCompany = await db.select().from(companies).where(eq(companies.id, company.id)).get();
      expect(updatedCompany?.creditPoolBalance).toBe(8); // Not refunded
    });
  });

  describe("markAttended", () => {
    it("preserves KNOWN BUG: checkin record is created with null bookingId", async () => {
      const { user, company } = await setupCorporateEnv(10);
      const [cls] = await db
        .insert(classes)
        .values({
          name: "Yoga",
          room: "A",
          capacity: 10,
          startsAt: new Date(Date.now() - 2 * 3600000).toISOString(),
          creditCost: 2,
        })
        .returning();

      const [booking] = await db.insert(corporateBookings).values({
        classId: cls.id,
        userId: user.id,
        companyId: company.id,
        status: "booked",
        creditsUsed: 2,
      }).returning();

      const staffCaller = appRouter.createCaller({
        db,
        user: { id: 999, role: "admin", name: "Admin", email: "admin@test.com" },
      } as any);

      await staffCaller.corporateBookings.markAttended({ bookingId: booking.id, source: "front_desk" });

      const updatedBooking = await db.select().from(corporateBookings).where(eq(corporateBookings.id, booking.id)).get();
      expect(updatedBooking?.status).toBe("attended");

      const checkinRecords = await db.select().from(checkins).where(eq(checkins.userId, user.id)).all();
      expect(checkinRecords.length).toBe(1);
      
      // ASSERT BUG: bookingId is null
      expect(checkinRecords[0].bookingId).toBeNull();
    });
  });
});
