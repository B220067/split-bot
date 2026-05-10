import { Prisma, PrismaClient } from "@prisma/client";

export type TripBalance = {
  userId: string;
  displayName: string;
  username: string | null;
  cents: number;
  amount: string;
};

export type SettlementTransaction = {
  fromUserId: string;
  fromDisplayName: string;
  toUserId: string;
  toDisplayName: string;
  cents: number;
  amount: string;
};

type TripParticipantWithUser = {
  userId: string;
  joinedAt: Date;
  user: {
    displayName: string | null;
    username: string | null;
    telegramId: string;
  };
};

function centsToAmount(cents: number): string {
  const absoluteCents = Math.abs(cents);
  const dollars = Math.floor(absoluteCents / 100);
  const remainder = String(absoluteCents % 100).padStart(2, "0");
  return `${cents < 0 ? "-" : ""}${dollars}.${remainder}`;
}

export function formatMoney(cents: number, currency: string = "$"): string {
  return `${currency}${centsToAmount(cents)}`;
}

export function parseAmountToCents(input: string): number {
  const normalized = input.trim().replace(/^[^\d]+/, "");
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) {
    throw new Error("Amount must be a positive number with up to 2 decimal places.");
  }

  const [wholePart, fractionPart = ""] = normalized.split(".");
  const paddedFraction = `${fractionPart}00`.slice(0, 2);
  return Number(wholePart) * 100 + Number(paddedFraction);
}

function toDisplayName(user: { displayName: string | null; username: string | null; telegramId: string }): string {
  if (user.displayName && user.displayName.trim().length > 0) {
    return user.displayName.trim();
  }

  if (user.username && user.username.trim().length > 0) {
    return `@${user.username.trim()}`;
  }

  return `Telegram ${user.telegramId}`;
}

function splitAmountEvenly(amountCents: number, participantCount: number): number[] {
  const baseShare = Math.floor(amountCents / participantCount);
  const remainder = amountCents % participantCount;

  return Array.from({ length: participantCount }, (_, index) => baseShare + (index < remainder ? 1 : 0));
}

function buildBalanceMap(participants: TripParticipantWithUser[], currency: string): Map<string, TripBalance> {
  return new Map(
    participants.map((participant) => [
      participant.userId,
      {
        userId: participant.userId,
        displayName: toDisplayName(participant.user),
        username: participant.user.username,
        cents: 0,
        amount: formatMoney(0, currency),
      },
    ]),
  );
}

function normalizeBalances(balanceMap: Map<string, TripBalance>, currency: string): TripBalance[] {
  return Array.from(balanceMap.values()).map((balance) => ({
    ...balance,
    amount: formatMoney(balance.cents, currency),
  }));
}

export async function calculateTripBalances(prisma: PrismaClient, tripId: string): Promise<TripBalance[]> {
  const tripInfo = await prisma.trip.findUnique({
    where: { id: tripId },
    select: { currency: true }
  });
  const currency = tripInfo?.currency || "$";

  const [participants, expenses] = await Promise.all([
    prisma.tripParticipant.findMany({
      where: { tripId },
      orderBy: [{ joinedAt: "asc" }, { userId: "asc" }],
      include: {
        user: true,
      },
    }),
    prisma.expense.findMany({
      where: { tripId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      include: {
        shares: true,
      },
    }),
  ]);

  const balanceMap = buildBalanceMap(participants, currency);

  if (participants.length === 0) {
    return [];
  }

  for (const expense of expenses) {
    const expenseCents = Math.round(expense.amount.toNumber() * 100);

    // Get or calculate shares
    const shares: { userId: string; cents: number }[] = [];

    if (expense.shares.length > 0) {
      // Use explicit shares from ExpenseShare
      for (const share of expense.shares) {
        shares.push({
          userId: share.userId,
          cents: Math.round(share.amount.toNumber() * 100),
        });
      }
    } else {
      // Fallback: split equally among eligible participants
      const eligibleParticipants = participants.filter((participant) => participant.joinedAt <= expense.createdAt);

      if (eligibleParticipants.length === 0) {
        continue;
      }

      const shareCents = splitAmountEvenly(expenseCents, eligibleParticipants.length);
      eligibleParticipants.forEach((participant, index) => {
        shares.push({
          userId: participant.userId,
          cents: shareCents[index],
        });
      });
    }

    // Apply shares
    for (const share of shares) {
      const existingBalance = balanceMap.get(share.userId);
      if (existingBalance) {
        existingBalance.cents -= share.cents;
      }
    }

    // Add to payer's balance
    const payerBalance = balanceMap.get(expense.payerId);
    if (payerBalance) {
      payerBalance.cents += expenseCents;
    }
  }

  return normalizeBalances(balanceMap, currency);
}

export async function simplifyDebts(prisma: PrismaClient, tripId: string): Promise<SettlementTransaction[]> {
  const tripInfo = await prisma.trip.findUnique({
    where: { id: tripId },
    select: { currency: true }
  });
  const currency = tripInfo?.currency || "$";

  const balances = await calculateTripBalances(prisma, tripId);
  const creditors = balances
    .filter((balance) => balance.cents > 0)
    .sort((left, right) => right.cents - left.cents);
  const debtors = balances
    .filter((balance) => balance.cents < 0)
    .sort((left, right) => left.cents - right.cents);

  const transactions: SettlementTransaction[] = [];
  let creditorIndex = 0;
  let debtorIndex = 0;

  while (creditorIndex < creditors.length && debtorIndex < debtors.length) {
    const creditor = creditors[creditorIndex];
    const debtor = debtors[debtorIndex];
    const transferCents = Math.min(creditor.cents, Math.abs(debtor.cents));

    transactions.push({
      fromUserId: debtor.userId,
      fromDisplayName: debtor.displayName,
      toUserId: creditor.userId,
      toDisplayName: creditor.displayName,
      cents: transferCents,
      amount: formatMoney(transferCents, currency),
    });

    creditor.cents -= transferCents;
    debtor.cents += transferCents;

    if (creditor.cents === 0) {
      creditorIndex += 1;
    }

    if (debtor.cents === 0) {
      debtorIndex += 1;
    }
  }

  return transactions;
}