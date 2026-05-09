import "dotenv/config";

import * as http from "http";
import { Prisma, PrismaClient } from "@prisma/client";
import { randomInt } from "node:crypto";
import { Bot, Context, session, SessionFlavor } from "grammy";
import { type ConversationFlavor, conversations, createConversation, type Conversation } from "@grammyjs/conversations";
import {
  calculateTripBalances,
  formatMoney,
  parseAmountToCents,
  simplifyDebts,
} from "./utils/settlement.js";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? process.env.BOT_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;

if (!TELEGRAM_BOT_TOKEN) {
  throw new Error("Missing TELEGRAM_BOT_TOKEN environment variable.");
}

if (!DATABASE_URL) {
  throw new Error("Missing DATABASE_URL environment variable.");
}

const prisma = new PrismaClient();

type SessionData = {
  currencyChoice?: string;
  conversation?: any;
};

type MyContext = ConversationFlavor<Context & SessionFlavor<SessionData>>;
type MyConversation = Conversation<MyContext, MyContext>;

const bot = new Bot<MyContext>(TELEGRAM_BOT_TOKEN);
bot.use(session({ initial: () => ({}) }));
bot.use(conversations());

type TelegramUserPayload = {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
};

function createTripCode(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  return Array.from({ length: 6 }, () => alphabet[randomInt(alphabet.length)]).join("");
}

function getDisplayName(from: TelegramUserPayload): string {
  const parts = [from.first_name, from.last_name].filter(Boolean);
  return parts.join(" ").trim() || from.username || `Telegram ${from.id}`;
}

async function getOrCreateUser(ctx: { from?: TelegramUserPayload }) {
  if (!ctx.from) {
    throw new Error("This command can only be used by a Telegram user.");
  }

  const telegramId = String(ctx.from.id);
  const displayName = getDisplayName(ctx.from);

  return prisma.user.upsert({
    where: { telegramId },
    create: {
      telegramId,
      displayName,
      username: ctx.from.username,
    },
    update: {
      displayName,
      username: ctx.from.username,
    },
  });
}

async function getCurrentTripParticipant(userId: string) {
  return prisma.tripParticipant.findFirst({
    where: { userId },
    orderBy: [{ lastUsedAt: "desc" }, { joinedAt: "desc" }],
    include: {
      trip: {
        include: {
          participants: {
            include: {
              user: true,
            },
            orderBy: [{ joinedAt: "asc" }, { userId: "asc" }],
          },
        },
      },
      user: true,
    },
  });
}

async function markTripAsCurrent(participantId: string) {
  await prisma.tripParticipant.update({
    where: { id: participantId },
    data: { lastUsedAt: new Date() },
  });
}

function parseCommandText(input: unknown): string {
  if (typeof input !== "string") {
    return "";
  }

  return input.trim();
}

async function resolveTripByCode(code: string) {
  return prisma.trip.findUnique({
    where: { code },
    include: {
      participants: {
        include: {
          user: true,
        },
      },
    },
  });
}

// ─── CONVERSATIONS ───

async function createTripConversation(conversation: MyConversation, ctx: MyContext) {
  let tripName = typeof ctx.match === 'string' ? ctx.match.trim() : '';
  
  if (!tripName && ctx.message?.text) {
    tripName = ctx.message.text.replace(/^\/create\s+/i, "").trim();
    if (tripName === "/create") tripName = "";
  }

  if (!tripName) {
    await ctx.reply("Usage: /create [trip_name]");
    return;
  }

  await ctx.reply("What currency will you use? (e.g., USD, EUR, GBP, or just $, €, £)");
  const currencyCtx = await conversation.wait();
  const currency = parseCommandText(currencyCtx.message?.text).slice(0, 10) || "$";

  const user = await getOrCreateUser(ctx);

  let trip: Awaited<ReturnType<typeof prisma.trip.create>> | null = null;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const code = createTripCode();

    try {
      trip = await prisma.$transaction(async (tx) => {
        const createdTrip = await tx.trip.create({
          data: {
            code,
            name: tripName,
            currency,
            createdById: user.id,
          },
        });

        await tx.tripParticipant.create({
          data: {
            tripId: createdTrip.id,
            userId: user.id,
            joinedAt: new Date(),
            lastUsedAt: new Date(),
          },
        });

        return createdTrip;
      });

      break;
    } catch (error) {
      if ((error as { code?: string }).code === "P2002") {
        continue;
      }

      throw error;
    }
  }

  if (!trip) {
    await ctx.reply("Could not generate a unique trip code. Please try again.");
    return;
  }

  await ctx.reply(`✅ Created trip "${trip.name}" (${currency})\nCode: \`${trip.code}\`\n\nShare this code for others to join!`, { parse_mode: 'MarkdownV2' });
}

async function addExpenseConversation(conversation: MyConversation, ctx: MyContext) {
  const user = await getOrCreateUser(ctx);
  const participant = await getCurrentTripParticipant(user.id);

  if (!participant) {
    await ctx.reply("You must create or join a trip before adding expenses.");
    return;
  }

  // Ask who pays
  await ctx.reply("Who paid? (type their display name or type 'me' if you paid)");
  const payerCtx = await conversation.wait();
  const payerName = parseCommandText(payerCtx.message?.text);

  if (!payerName) {
    await ctx.reply("Invalid payer name.");
    return;
  }

  // Find payer
  const payerParticipant = participant.trip.participants.find(
    (p) =>
      (p.user.displayName?.toLowerCase().includes(payerName.toLowerCase()) ||
        p.user.username?.toLowerCase().includes(payerName.toLowerCase())) ||
      payerName.toLowerCase() === "me"
  );

  const payerId = payerName.toLowerCase() === "me" ? user.id : payerParticipant?.userId;

  if (!payerId) {
    await ctx.reply("Payer not found in trip participants.");
    return;
  }

  // Ask split type
  await ctx.reply("How to split? (type 'equal' or 'custom')");
  const splitCtx = await conversation.wait();
  const splitType = parseCommandText(splitCtx.message?.text).toLowerCase();

  if (!["equal", "custom"].includes(splitType)) {
    await ctx.reply("Invalid split type. Use 'equal' or 'custom'.");
    return;
  }

  // Ask amount
  await ctx.reply(`What is the total amount paid? (in ${participant.trip.currency})`);
  const amountCtx = await conversation.wait();
  const amountStr = parseCommandText(amountCtx.message?.text);

  let amountCents = 0;
  try {
    amountCents = parseAmountToCents(amountStr);
  } catch (error) {
    await ctx.reply(error instanceof Error ? error.message : "Invalid amount.");
    return;
  }

  if (amountCents <= 0) {
    await ctx.reply("Amount must be greater than zero.");
    return;
  }

  // Ask description
  await ctx.reply("What is this expense for? (description)");
  const descCtx = await conversation.wait();
  const description = parseCommandText(descCtx.message?.text);

  if (!description) {
    await ctx.reply("Description cannot be empty.");
    return;
  }

  const expenseCreatedAt = new Date();
  const eligibleParticipants = await prisma.tripParticipant.findMany({
    where: {
      tripId: participant.tripId,
      joinedAt: { lte: expenseCreatedAt },
    },
    orderBy: [{ joinedAt: "asc" }, { userId: "asc" }],
    include: {
      user: true,
    },
  });

  if (eligibleParticipants.length === 0) {
    await ctx.reply("There are no trip participants to split this expense with.");
    return;
  }

  // Handle split
  let shares: { userId: string; amountCents: number }[] = [];

  if (splitType === "equal") {
    const baseShare = Math.floor(amountCents / eligibleParticipants.length);
    const remainder = amountCents % eligibleParticipants.length;

    shares = eligibleParticipants.map((p, index) => ({
      userId: p.userId,
      amountCents: baseShare + (index < remainder ? 1 : 0),
    }));
  } else {
    // custom split
    const shares_map = new Map<string, number>();
    let remainingAmount = amountCents;

    for (const participant_item of eligibleParticipants) {
      const displayName = participant_item.user.displayName?.trim() || `@${participant_item.user.username}`;
      await ctx.reply(`How much of the ${participant.trip.currency}${formatMoney(amountCents).slice(1)} did ${displayName} use? (${participant.trip.currency}${formatMoney(remainingAmount).slice(1)} remaining)`);
      const shareCtx = await conversation.wait();
      const shareStr = parseCommandText(shareCtx.message?.text);

      let shareCents = 0;
      try {
        shareCents = parseAmountToCents(shareStr);
      } catch (error) {
        await ctx.reply(`Invalid amount for ${displayName}. Ending split configuration.`);
        return;
      }
      
      remainingAmount -= shareCents;
      shares_map.set(participant_item.userId, shareCents);
    }

    shares = Array.from(shares_map.entries()).map(([userId, userAmountCents]) => ({
      userId,
      amountCents: userAmountCents,
    }));
    
    const sumCents = shares.reduce((a, b) => a + b.amountCents, 0);
    if(sumCents !== amountCents) {
       await ctx.reply(`Warning: The custom parts sum to ${formatMoney(sumCents)} instead of ${formatMoney(amountCents)}. Using custom sums.`);
    }
  }

  // Create expense and shares
  const expense = await prisma.expense.create({
    data: {
      tripId: participant.tripId,
      payerId,
      amount: new Prisma.Decimal(amountCents / 100),
      description,
      createdAt: expenseCreatedAt,
    },
  });

  for (const share of shares) {
    await prisma.expenseShare.create({
      data: {
        expenseId: expense.id,
        userId: share.userId,
        amount: new Prisma.Decimal(share.amountCents / 100),
      },
    });
  }

  await markTripAsCurrent(participant.id);

  const settlement = await simplifyDebts(prisma, participant.tripId);

  await ctx.reply(
    [
      `✅ Added ${participant.trip.currency}${formatMoney(amountCents).slice(1)} for "${description}"`,
      `Split among ${eligibleParticipants.length} participant(s).`,
      settlement.length > 0
        ? `Settlement transactions needed: ${settlement.length}`
        : "Everyone is settled up!",
    ].join("\n"),
  );
}

// ─── COMMANDS ───

bot.command("start", async (ctx) => {
  await ctx.reply(
    [
      "👋 Welcome to Split Bot!",
      "",
      "How to use:",
      "1. Create a trip with /create [trip_name]. You will be the admin.",
      "2. Share the 6-character trip code with your friends.",
      "3. Your friends can join via /join [code] [their_display_name].",
      "4. Anyone can add an expense using /add (you'll be asked who paid and how to split).",
      "5. Use /status to view the current split state.",
      "6. Finally, the admin uses /collate to close the trip and generate final settlement debts.",
      "7. Use /paid [their_name] to check off debts after collating.",
    ].join("\n"),
  );
});

bot.use(createConversation(createTripConversation, "create_trip"));
bot.use(createConversation(addExpenseConversation, "add_expense"));

bot.command("create", async (ctx) => {
  await ctx.conversation.enter("create_trip");
});

bot.command("join", async (ctx) => {
  const parts = parseCommandText(ctx.match).split(/\s+/);
  const code = parts[0]?.toUpperCase() || "";
  const displayName = parts.slice(1).join(" ").trim();

  if (!/^[A-Z0-9]{6}$/.test(code) || !displayName) {
    await ctx.reply("Usage: /join [6-character code] [display name]");
    return;
  }

  const user = await getOrCreateUser(ctx);
  const trip = await resolveTripByCode(code);

  if (!trip) {
    await ctx.reply("Invalid trip code. Ask the trip owner for the correct code.");
    return;
  }

  // Update their display name as requested during join
  await prisma.user.update({
    where: { id: user.id },
    data: { displayName },
  });

  const existingParticipant = await prisma.tripParticipant.findUnique({
    where: {
      tripId_userId: {
        tripId: trip.id,
        userId: user.id,
      },
    },
  });

  if (existingParticipant) {
    await prisma.tripParticipant.update({
      where: { id: existingParticipant.id },
      data: { lastUsedAt: new Date() },
    });
    await ctx.reply(`✅ Rejoined "${trip.name}" as ${displayName}. It is now your active trip.`);
  } else {
    await prisma.tripParticipant.create({
      data: {
        tripId: trip.id,
        userId: user.id,
        joinedAt: new Date(),
        lastUsedAt: new Date(),
      },
    });
    await ctx.reply(`✅ Joined "${trip.name}" as ${displayName}. It is now your active trip.`);
  }
});

bot.command("add", async (ctx) => {
  await ctx.conversation.enter("add_expense");
});

bot.command("collate", async (ctx) => {
  const user = await getOrCreateUser(ctx);
  const participant = await getCurrentTripParticipant(user.id);

  if (!participant) {
    await ctx.reply("You must create or join a trip first.");
    return;
  }

  // Check if user is trip admin
  if (participant.trip.createdById !== user.id) {
    await ctx.reply("❌ Only the trip admin can finalize expenses.");
    return;
  }

  if (participant.trip.isCollated) {
    await ctx.reply("This trip has already been finalized.");
    return;
  }

  const settlement = await simplifyDebts(prisma, participant.tripId);

  // Create settlement debts
  for (const transaction of settlement) {
    await prisma.settlementDebt.create({
      data: {
        tripId: participant.tripId,
        debtorId: transaction.fromUserId,
        creditorId: transaction.toUserId,
        amount: new Prisma.Decimal(transaction.cents / 100),
        isPaid: false,
      },
    });
  }

  // Mark trip as collated
  await prisma.trip.update({
    where: { id: participant.tripId },
    data: { isCollated: true },
  });

  await ctx.reply(`✅ Trip finalized! ${settlement.length} settlement transactions created. Use /status to view them.`);
});

bot.command("paid", async (ctx) => {
  const user = await getOrCreateUser(ctx);
  const participant = await getCurrentTripParticipant(user.id);

  if (!participant) {
    await ctx.reply("You must create or join a trip first.");
    return;
  }

  if (!participant.trip.isCollated) {
    await ctx.reply("The trip admin must /collate the trip first before debts can be explicitly marked as paid.");
    return;
  }

  const parts = parseCommandText(ctx.match).split(/\s+/);
  const creditorName = parts.join(" ").trim(); // We assume someone will say "/paid chloe" if they are paying chloe

  if (!creditorName) {
    await ctx.reply("Usage: /paid [who_you_paid] (e.g. /paid chloe)");
    return;
  }

  // Determine debtor (the sender) and creditor (target)
  const debtorId = user.id;

  const creditorParticipant = participant.trip.participants.find(
    (p) =>
      p.user.displayName?.toLowerCase().includes(creditorName.toLowerCase()) ||
      p.user.username?.toLowerCase().includes(creditorName.toLowerCase())
  );

  if (!creditorParticipant) {
    await ctx.reply("Person taking the payment was not found.");
    return;
  }

  // Find settlement debt
  const debt = await prisma.settlementDebt.findFirst({
    where: {
      tripId: participant.tripId,
      debtorId: debtorId,
      creditorId: creditorParticipant.userId,
      isPaid: false,
    },
  });

  if (!debt) {
    await ctx.reply(`No unpaid debt found where you owe ${creditorName}.`);
    return;
  }

  // Mark as paid
  await prisma.settlementDebt.update({
    where: { id: debt.id },
    data: { isPaid: true },
  });

  await ctx.reply(
    `✅ Marked ${participant.trip.currency}${formatMoney(Math.round(debt.amount.toNumber() * 100)).slice(1)} payment to ${creditorParticipant.user.displayName || creditorParticipant.user.username} as paid.`,
  );
});

bot.command("status", async (ctx) => {
  const user = await getOrCreateUser(ctx);
  const participant = await getCurrentTripParticipant(user.id);

  if (!participant) {
    await ctx.reply("You are not in any trip yet. Use /create or /join first.");
    return;
  }

  await markTripAsCurrent(participant.id);

  let statusText = [
    `📍 Trip: ${participant.trip.name}`,
    `Code: ${participant.trip.code}`,
    `Currency: ${participant.trip.currency}`,
    `Status: ${participant.trip.isCollated ? "✅ Finalized" : "⏳ In Progress"}`,
    "",
  ];

  if (!participant.trip.isCollated) {
     // Show dynamic debts before collating
     const dynamicDebts = await simplifyDebts(prisma, participant.tripId);
     if (dynamicDebts.length === 0) {
        statusText.push("No debts recorded yet or everyone is settled up!");
     } else {
        statusText.push("💰 Current Unofficial Debts:");
        for (const debt of dynamicDebts) {
          statusText.push(
            `  ${debt.fromDisplayName} owes ${debt.toDisplayName}: ${participant.trip.currency}${debt.amount.replace("$", "")}`
          );
        }
     }
  } else {
    // Show fixed debts after collating
    const debts = await prisma.settlementDebt.findMany({
      where: { tripId: participant.tripId },
      include: {
        debtor: true,
        creditor: true,
      },
    });

    const paidDebts = debts.filter((d) => d.isPaid);
    const unpaidDebts = debts.filter((d) => !d.isPaid);

    if (unpaidDebts.length === 0 && paidDebts.length === 0) {
      statusText.push("No debts generated.");
    } else {
      if (unpaidDebts.length > 0) {
        statusText.push("💰 Unpaid:");
        for (const debt of unpaidDebts) {
          statusText.push(
            `  [Unpaid] ${debt.debtor.displayName} owes ${debt.creditor.displayName}: ${participant.trip.currency}${formatMoney(Math.round(debt.amount.toNumber() * 100)).slice(1)}`,
          );
        }
      }

      if (paidDebts.length > 0) {
        statusText.push("");
        statusText.push("✅ Paid:");
        for (const debt of paidDebts) {
          statusText.push(
            `  [Paid] ${debt.debtor.displayName} → ${debt.creditor.displayName}: ${participant.trip.currency}${formatMoney(Math.round(debt.amount.toNumber() * 100)).slice(1)}`,
          );
        }
      }
    }
  }

  await ctx.reply(statusText.join("\n"));
});

bot.catch((error) => {
  console.error("Bot error:", error.error);
});

async function main() {
  try {
    await prisma.$connect();
    console.log("Database connected successfully");

    const PORT = process.env.PORT || 8080;
    http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("Bot is alive!");
    }).listen(PORT, () => {
      console.log(`Keep-alive server listening on port ${PORT}`);
    });

    console.log("Bot is starting...");
    await bot.start();

  } catch (error) {
    console.error("Failed to start:", error);
    process.exit(1);
  }
}

main();
