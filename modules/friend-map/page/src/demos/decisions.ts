// Methodology's Decision history: why the closeness score's rules are what
// they are. Each entry is one decision the user made, newest first: the
// question, the options weighed, the table they were compared on, the user's words,
// and what changed. It is a record, so its numbers are those of the day it was
// decided, never worked out from today's settings; a later decision that
// replaces one adds an entry of its own and names it in the older one's
// `replacedBy`. Add a decision as one more object at the top. No real names,
// here or in the quotes: "[a friend]" stands for one.

/** A table the options were compared on: its rows' first cell names the row. */
export interface Comparison {
  caption: string;
  head: string[];
  rows: string[][];
}

export interface Decision {
  /** The local day it was decided, YYYY-MM-DD. */
  day: string;
  title: string;
  question: string;
  /** What raised it, in the user's words, when they raised it. */
  asked?: string;
  /** Every option weighed, the one taken `chosen`. */
  options: Array<{ name: string; detail: string; chosen?: boolean }>;
  compared: Comparison[];
  /** What they decided, in their words, lightly trimmed (an ellipsis for what is left out, square brackets for a word put in). */
  decided: string;
  /** What changed in the score, and where. */
  changed: string;
  /** The later decision that replaced this one, by its title. */
  replacedBy?: string;
}

/** Newest first. */
export const DECISIONS: Decision[] = [
  {
    day: "2026-10-15",
    title: "Long trips count less for each hour",
    question: "Should a trip's hours count less the longer it is?",
    asked: "Should we perhaps have a diminishing uh curve on that? I'm open to suggestions in terms of what feels appropriate.",
    options: [
      { name: "Every hour whole", detail: "what trips did: each hour 50, so ten whole days away with one friend counted 7,000, nearly six times the whole score of the closest friend in a made-up crowd (about 1,200)" },
      { name: "4 hours whole, then the square root", detail: "4 × √(hours ÷ 4) past the first 4" },
      { name: "8 hours whole, then the square root", detail: "8 × √(hours ÷ 8) past the first 8: a long trip still counts for more than a short one, ever less for each hour more", chosen: true },
    ],
    compared: [{
      caption: "A trip with one friend, at 50 messages an hour and 14 hours together a whole day",
      head: ["trip", "every hour whole", "4 hours whole", "8 hours whole"],
      rows: [
        ["1 day, 14 hours", "700", "374", "529"],
        ["2 days, 28 hours", "1,400", "529", "748"],
        ["5 days, 70 hours", "3,500", "837", "1,183"],
        ["10 days, 140 hours", "7,000", "1,183", "1,673"],
        ["30 days, 420 hours", "21,000", "2,049", "2,898"],
      ],
    }],
    decided: "Yep, yeah, this curve works fine for me. ... Um yeah, eight hours is fine.",
    changed:
      "A trip's time together counts whole for its first tripFullHours (a new setting, 8), then as F × √(hours ÷ F) (tripCountedHours in src/catchUps.ts), shared out over its days by each one's time together, so each day still fades on its own (catchUpCountedDayHours). A hangout on one date counts every hour whole, as before.",
  },
  {
    day: "2026-10-15",
    title: "Trips count their time together",
    question: "How should a trip away with people, over several days, count toward closeness?",
    asked:
      "I'm thinking a multi-day event where for example I was traveling with some people ... we define private hours in a day say as 10 and then it just like takes the days of travel um and minus the the private hours every day and And then count the rest of the time towards time spending together.",
    options: [
      { name: "A hangout for each day", detail: "what Add event allowed: each day added by hand, with its own hours, and nothing tying them together" },
      { name: "Private hours a day", detail: "the first plan: each day of it counts 24 less 10 private hours, 14, the first and last days whole" },
      { name: "A start, an end and a private window", detail: "when it started and ended, each a date and a time, less the hours each day kept private (midnight to 10 am to start)", chosen: true },
    ],
    compared: [{
      caption: "A trip with one friend leaving at 6 pm, home at 2 pm two days later, at 50 messages an hour",
      head: ["day", "private hours a day", "start, end and window"],
      rows: [
        ["first", "14 hours", "6 hours"],
        ["second", "14 hours", "14 hours"],
        ["last", "14 hours", "4 hours"],
        ["in all", "42 hours, 2,100", "24 hours, 1,200"],
      ],
    }],
    decided:
      "Set a private hours between midnight to ten AM maybe and then ... the start date needs a time and then the end date needs a time as well ... Just so we are not additionally counting many extra hours if we don't track the time.",
    changed:
      "A hangout may be a trip (src/catchUps.ts): from its start to its end less each day's private window, each day's part counted on its own date and fading from there (catchUpDayHours in closeness.ts). An hour is still worth catchUpHourWorth, as at any hangout.",
  },
  {
    day: "2026-10-07",
    title: "Calls count from 1 minute",
    question: "How long must a day's answered calls with someone add up to before they count?",
    options: [
      { name: "From 5 minutes", detail: "the code's default: past “I'm outside” and voicemail, which a call history counts as answered when you called" },
      { name: "From 1 minute", detail: "short calls count too, at their length", chosen: true },
    ],
    compared: [{
      caption: "What a day's calls count, at 50 messages an hour",
      head: ["a day's calls", "from 5 minutes", "from 1 minute"],
      rows: [
        ["30 seconds", "0", "0"],
        ["3 minutes", "0", "2.5"],
        ["30 minutes", "25", "25"],
      ],
    }],
    decided: "In the settings, let's lower call minimum minutes to one minute.",
    changed: "data/settings.json sets callMinimumMinutes to 1, so a day's answered calls count from 1 minute instead of 5. The code's default stays 5.",
  },
  {
    day: "2026-10-07",
    title: "Sharing a group's time",
    question: "How much of a hangout or a call with several people should each of them get?",
    asked:
      "I don't think it should add up to one ... dividing 100% by the people might not feel quite right. Because when you speak, ... half the time you'll probably be speaking to everyone. And then the other half is maybe directly chatting with one person.",
    options: [
      { name: "Equal split, 1/n", detail: "what it was: each of n people gets 1/n of the time" },
      { name: "Half shared, ½ + ½ ÷ n", detail: "half the time is with everyone at once, the other half split equally; never under 50%", chosen: true },
      { name: "Square root, 1/√n", detail: "firstmate's pick: keeps falling with size (20% at 25), where half shared stays over 50% and may overstate a big party" },
      { name: "Presence bonus", detail: "25 for each person at each hangout, for having seen them, beside either rule" },
    ],
    compared: [
      {
        caption: "Each person's share of the time, by how many people were there besides you",
        head: ["people there", "equal split, 1/n", "half shared, ½ + ½ ÷ n", "square root, 1/√n"],
        rows: [
          ["1", "100%", "100%", "100%"],
          ["2", "50%", "75%", "71%"],
          ["4", "25%", "63%", "50%"],
          ["9", "11%", "56%", "33%"],
          ["25", "4%", "52%", "20%"],
        ],
      },
      {
        caption: "Worked through at 50 messages an hour, each person gets",
        head: ["", "equal split", "bonus + square root", "half shared, as chosen"],
        rows: [
          ["3-hour dinner, 4 people", "37.5", "100", "93.75"],
          ["1-hour coffee, one friend", "50", "75", "50"],
        ],
      },
    ],
    decided:
      "I like half shared for methodology ... I want this to only apply to in-person group hangouts. And not group messages. Group messages are like, most of the time, you can't actually say somebody's listening just because you said something in a group. So in person hangouts and calls should get this. And we're not going to add a hangout constant bonus because this already kind of gives a bonus.",
    changed:
      "A hangout, or a call logged with several people, gives each of the n people there s + (1 − s) ÷ n of its time, s being the new setting groupSharedPart (0.5); one person is unchanged. Group chats keep their own rule, and there is no presence bonus. This history began here, so the table each decision was made from is kept.",
  },
  {
    day: "2026-10-07",
    title: "Direct messages by their balance",
    question: "Should a month of one-way messages count as much as an even exchange? Someone who sends a stream of updates you stopped answering is not as close as a friend who writes as much as you.",
    options: [
      { name: "Plain count", detail: "what it was: every message 1, whoever sent it" },
      { name: "2√(yours × theirs)", detail: "twice the geometric mean of a month's two sides: the plain count when even, less the more lopsided, nothing one-way", chosen: true },
      { name: "Cap at a multiple", detail: "the bigger side counts only up to a set multiple of the smaller" },
    ],
    compared: [{
      caption: "A month of 100 direct messages, theirs / yours",
      head: ["theirs / yours", "plain count", "2√(theirs × yours)"],
      rows: [
        ["50 / 50", "100", "100"],
        ["90 / 10", "100", "60"],
        ["99 / 1", "100", "20"],
        ["100 / 0", "100", "0"],
        ["10 / 90", "100", "60"],
      ],
    }],
    decided:
      "Yeah, I like your proposal of the asymmetric messaging scoring. Let's go with that. That sounds like a sensible starting point ... And use curves to describe like functions wherever you can in methodology.",
    changed:
      "Each month's direct messages count 2√(yours × theirs) before fading, blended with the plain count by the new setting messageReciprocity (1). Group chats, one-sided chats, hangouts and calls unchanged; Methodology draws each rule that is a function as a curve.",
  },
  {
    day: "2026-10-06",
    title: "A call of unknown length counts nothing",
    question: "What should a call count when its app does not say how long it was (WeChat's compressed records, Signal, Messenger's phone-app export)?",
    options: [
      { name: "A typical length", detail: "a guess from the calls whose length is known" },
      { name: "Nothing, until you give it one", detail: "Add length in the chat, and it then counts as any call that long", chosen: true },
    ],
    compared: [{
      caption: "The calls whose length is known",
      head: ["", "length"],
      rows: [
        ["median", "about 1.5 minutes"],
        ["average", "about 13 minutes"],
      ],
    }],
    decided:
      "[I'd] rather understate our closeness than overstate it ... just call with unknown length ... don't even assign any attribution and let me go through each call ... and fill in the length.",
    changed: "A call whose length is not known counts nothing toward closeness. Add length beside it in the chat gives it one, kept apart from what the app said.",
  },
  {
    day: "2026-10-06",
    title: "Hangouts split equally",
    question: "Should everyone at a hangout get its whole worth?",
    options: [
      { name: "The whole worth each", detail: "what it was: everyone named at it got all of it" },
      { name: "Split equally", detail: "among everyone at it, you not counted, the others you did not name too", chosen: true },
    ],
    compared: [{
      caption: "2 hours at 50 messages an hour, each person gets",
      head: ["people there", "the whole worth", "split equally"],
      rows: [
        ["1", "100", "100"],
        ["2", "100", "50"],
        ["5", "100", "20"],
      ],
    }],
    decided: "Make catch-ups closeness weight equal for all participants. So duration split equally by everyone involved.",
    changed: "Each person at a hangout gets its hours × catchUpHourWorth ÷ the people there.",
    replacedBy: "Sharing a group's time",
  },
  {
    day: "2026-10-06",
    title: "An hour together is 50 messages",
    question: "How many direct messages should time together count as?",
    options: [
      { name: "A worth for each sort", detail: "what it was: 50 for a long one and 15 for a short one, in person or by phone" },
      { name: "50 an hour", detail: "one worth by the hour, in person or by call alike: about one solid day of texting", chosen: true },
    ],
    compared: [{
      caption: "Days of one-to-one messages in your 50 most-messaged chats over two years, both ways",
      head: ["a day with", "messages on average"],
      rows: [
        ["any messages", "11"],
        ["20 or more", "about 49"],
      ],
    }],
    decided: "Give me a [weight] ... how many hours we caught up. Give me a free number field. And it defaults to one.",
    changed:
      "One setting, catchUpHourWorth, for every hangout: its hours × 50, firstmate's measure from the table, which the user confirmed. A day's answered calls count their connected hours at the same worth, once they reach callMinimumMinutes (5).",
  },
];
