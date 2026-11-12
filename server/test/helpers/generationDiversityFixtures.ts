// Realistic diversity fixtures.
//
// The Plan carries the domain vocabulary (the planner is shown that vocabulary, so it can satisfy
// this), while the learner-facing candidate is plain English that usually carries no classifier
// signal at all. The candidates here are written that way, not with one domain-classifier keyword
// planted per Build a Sentence Item: text reverse-engineered from the classifier's own rules passes
// the suite while an ordinary exchange ("When does the group meeting begin?" / "It starts
// tomorrow.") fails as plan-drift. Most Build a Sentence Items below therefore classify as
// `everyday-life` whatever their Plan declares, as real ones do.
const speakingCandidateSentences = [
  "Please sign in when you arrive.",
  "Bring your insurance card to the front desk.",
  "Your first appointment starts at ten.",
  "Try to arrive early so we can check your details.",
  "The waiting room is just past the elevator.",
  "A coordinator will call your name when the room is ready.",
  "If you need to change the time, phone the clinic before Friday.",
] as const;

const interviewCandidateQuestions = [
  {
    type: "factual" as const,
    question: "Where do you check the bus schedule before a weekend trip?",
  },
  {
    type: "experience" as const,
    question: "Tell me about a time you waited at a busy ticket counter.",
  },
  {
    type: "opinion" as const,
    question: "Do you prefer buying a seat in advance or paying when you board?",
  },
  {
    type: "opinion" as const,
    question: "Should the city add more late services on Sunday evenings?",
  },
] as const;

// Ten independent situations. Each Plan situation names its domain in ordinary prose; each matching
// candidate exchange is written the way a real Build a Sentence Item reads, with no classifier
// keyword planted in it.
const buildSentencePlanSituations = [
  {
    domain: "campus-academics",
    situation: "a course adviser confirms when a study workshop meets",
    participantRoles: ["adviser", "first-year advisee"],
    noveltyKey: "advising-workshop-signup",
    requiredConcepts: ["sign-up sheet", "front table"],
  },
  {
    domain: "workplace-business",
    situation: "an office manager moves a client visit to another day",
    participantRoles: ["reception assistant", "visiting client"],
    noveltyKey: "office-client-visit-reschedule",
    requiredConcepts: ["new time", "tomorrow morning"],
  },
  {
    domain: "services-travel",
    situation: "a hotel desk clerk explains a late departure from a room",
    participantRoles: ["desk clerk", "weekend guest"],
    noveltyKey: "hotel-late-checkout-charge",
    requiredConcepts: ["late check-out", "extra charge"],
  },
  {
    domain: "health-wellbeing",
    situation: "a clinic receptionist confirms a return visit",
    participantRoles: ["receptionist", "returning patient"],
    noveltyKey: "clinic-followup-visit-timing",
    requiredConcepts: ["follow-up visit", "Thursday afternoon"],
  },
  {
    domain: "arts-culture",
    situation: "a gallery assistant describes when a new display opens",
    participantRoles: ["gallery assistant", "weekend visitor"],
    noveltyKey: "gallery-exhibit-opening-hours",
    requiredConcepts: ["new exhibit", "opening hours"],
  },
  {
    domain: "community-civic",
    situation: "a neighborhood association arranges a park tidy-up",
    participantRoles: ["association secretary", "nearby resident"],
    noveltyKey: "neighborhood-park-cleanup-day",
    requiredConcepts: ["park cleanup", "Saturday morning"],
  },
  {
    domain: "campus-academics",
    situation: "a library assistant explains how to keep a borrowed volume",
    participantRoles: ["library assistant", "borrower"],
    noveltyKey: "library-book-renewal-window",
    requiredConcepts: ["renew a book", "due date"],
  },
  {
    domain: "workplace-business",
    situation: "a company trainer arranges a safety talk for new hires",
    participantRoles: ["trainer", "new hire"],
    noveltyKey: "company-safety-briefing-schedule",
    requiredConcepts: ["safety briefing", "second floor"],
  },
  {
    domain: "services-travel",
    situation: "a station attendant announces a change of platform",
    participantRoles: ["station attendant", "commuter"],
    noveltyKey: "station-platform-change-notice",
    requiredConcepts: ["platform change", "later departure"],
  },
  {
    domain: "health-wellbeing",
    situation: "a campus nurse explains an exercise group for better sleep",
    participantRoles: ["nurse", "group member"],
    noveltyKey: "nurse-exercise-class-schedule",
    requiredConcepts: ["exercise class", "Monday evening"],
  },
] as const;

const buildSentenceCandidateItems = [
  { prompt: "Where is the sign-up sheet?", answer: ["It", "is", "on", "the", "front", "table."] },
  { prompt: "When is the new time?", answer: ["It", "is", "tomorrow", "morning."] },
  { prompt: "Is there an extra charge for the late check-out?", answer: ["Yes,", "it", "costs", "ten", "dollars."] },
  { prompt: "When is the follow-up visit?", answer: ["It", "is", "Thursday", "afternoon."] },
  { prompt: "What are the opening hours for the new exhibit?", answer: ["They", "run", "until", "six."] },
  { prompt: "When does the park cleanup begin?", answer: ["It", "begins", "Saturday", "morning."] },
  { prompt: "How do I renew the book before the due date?", answer: ["Ask", "at", "the", "desk", "downstairs."] },
  { prompt: "Where is the safety briefing?", answer: ["It", "is", "on", "the", "second", "floor."] },
  { prompt: "Why did the platform change?", answer: ["A", "later", "departure", "was", "added."] },
  { prompt: "When does the exercise class meet?", answer: ["It", "meets", "Monday", "evening."] },
] as const;

export function speakingPlanFixture(): SpeakingGenerationPlan {
  return {
    version: "cross-set-diversity-v1" as const,
    kind: "speaking" as const,
    listenAndRepeat: {
      domain: "health-wellbeing" as const,
      setting: "walk-in clinic waiting room",
      speakerRole: "front desk coordinator",
      communicativePurpose: "explain how to prepare for a first appointment",
      noveltyKey: "clinic-first-appointment-preparation",
      requiredConcepts: ["clinic appointment", "arrive early", "insurance card"],
      distinguishesFrom: [],
    },
    interview: {
      domain: "services-travel" as const,
      topic: "the intercity bus for weekend trips",
      premise: "a short survey about how riders plan weekend travel",
      questionArc: [
        "checking the bus schedule before a trip",
        "an experience waiting at a busy ticket counter",
        "buying a seat in advance versus paying on board",
        "whether the city should add late Sunday services",
      ] as [string, string, string, string],
      noveltyKey: "intercity-bus-weekend-trip-planning",
      requiredConcepts: ["bus schedule", "weekend trip", "ticket counter"],
      distinguishesFrom: [],
    },
  };
}

export function writingPlanFixture(): WritingGenerationPlan {
  const situations = buildSentencePlanSituations.map((situation) => ({
    domain: situation.domain,
    situation: situation.situation,
    participantRoles: [...situation.participantRoles] as [string, string],
    noveltyKey: situation.noveltyKey,
    requiredConcepts: [...situation.requiredConcepts],
    distinguishesFrom: [],
  })) as unknown as WritingGenerationPlan["buildASentence"]["situations"];
  return {
    version: "cross-set-diversity-v1" as const,
    kind: "writing" as const,
    buildASentence: {
      situations,
    },
    email: {
      domain: "technology-media" as const,
      situation: "asking a podcast club to move a recording session",
      recipientRole: "podcast club organizer",
      communicativeActs: [
        "explain the scheduling conflict",
        "propose two other dates",
        "ask the organizer to confirm",
      ] as [string, string, string],
      noveltyKey: "podcast-club-session-reschedule",
      requiredConcepts: [
        "recording session",
        "scheduling conflict",
        "two other dates",
      ],
      distinguishesFrom: [],
    },
    academicDiscussion: {
      domain: "history-social-change" as const,
      proposition:
        "communities should reuse local heritage buildings rather than replace them",
      competingValues: [
        "visible links to the local past",
        "the lower cost of modern upgrades",
      ] as [string, string],
      noveltyKey: "heritage-building-reuse-debate",
      requiredConcepts: [
        "heritage buildings",
        "reuse",
        "modern upgrades",
      ],
      distinguishesFrom: [],
    },
  };
}

export function speakingSetFixture(): SpeakingSet {
  return {
    id: "spk-diverse",
    kind: "speaking" as const,
    source: "generated" as const,
    createdAt: "2026-07-31T00:00:00Z",
    listenAndRepeat: {
      scenarioTitle: "A First Visit to the Walk-In Clinic",
      scenarioDescription:
        "A front desk coordinator explains what a new patient should bring and do before a first appointment.",
      items: speakingCandidateSentences.map((sentence, index) => ({
        id: `lr-${index + 1}`,
        sentence,
        audio: "",
        responseWindowSec: ([8, 8, 10, 10, 10, 12, 12] as const)[index],
      })),
    },
    interview: {
      scenarioTitle: "Weekend Bus Travel",
      intro:
        "You are answering a short survey about how riders plan weekend trips on the intercity bus.",
      introAudio: "",
      questions: interviewCandidateQuestions.map((question, index) => ({
        id: `int-${index + 1}`,
        ...question,
        audio: "",
        responseWindowSec: 45 as const,
      })),
    },
  };
}

export function writingSetFixture(): WritingSet {
  return {
    id: "wri-diverse",
    kind: "writing" as const,
    source: "generated" as const,
    createdAt: "2026-07-31T00:00:00Z",
    buildASentence: {
      items: buildSentenceCandidateItems.map((item, index) => ({
        id: `bas-${index + 1}`,
        prompt: item.prompt,
        tiles: [...item.answer],
        answers: [[...item.answer]],
      })),
    },
    email: {
      id: "email-1",
      scenario:
        "You cannot attend the recording session your club planned, and you want to suggest two other dates.",
      to: "podcast-club@university.edu",
      subject: "Request to move our recording session",
      bullets: [
        "Explain the scheduling conflict.",
        "Propose two other dates.",
        "Ask the organizer to confirm.",
      ],
      timeLimitSec: 420 as const,
      wordGuidance: { min: 80 as const, max: 120 as const },
    },
    academicDiscussion: {
      id: "disc-1",
      courseTitle: "Urban Studies",
      professorName: "Dr. Alvarez",
      professorPost:
        "Some towns keep old heritage buildings in use while others clear them for new construction. " +
        "Should communities reuse heritage buildings rather than replace them with modern upgrades?",
      studentPosts: [
        {
          name: "Mina",
          post: "Reuse keeps visible links to the local past on ordinary streets.",
        },
        {
          name: "Leo",
          post: "Modern upgrades cost less over time and serve more people.",
        },
      ],
      timeLimitSec: 600 as const,
      minWords: 100 as const,
    },
  };
}
// A second realistic Writing Plan and its matching candidate, unrelated to the pair above, showing
// the rules can be satisfied more than once against a bank that already holds a Set. They are
// written by hand because only hand-written content shows the rules can be met, not just passed.
const alternativeSituations = [
  {
    domain: "science-environment",
    situation: "a laboratory assistant confirms when an experiment starts",
    participantRoles: ["lab assistant", "project partner"],
    noveltyKey: "laboratory-experiment-start-time",
    requiredConcepts: ["start time", "the samples"],
    prompt: "When is the start time?",
    answer: ["The", "samples", "arrive", "in", "the", "lab", "first."],
    distractor: "arrived",
  },
  {
    domain: "technology-media",
    situation: "a software club explains how to join an online channel",
    participantRoles: ["club organizer", "new member"],
    noveltyKey: "software-club-channel-invite",
    requiredConcepts: ["join the channel", "invite link"],
    prompt: "How do I join the channel?",
    answer: ["Use", "the", "invite", "link", "in", "the", "email."],
    distractor: "links",
  },
  {
    domain: "community-civic",
    situation: "a city office announces a public meeting about a footpath",
    participantRoles: ["council clerk", "local resident"],
    noveltyKey: "city-footpath-public-meeting",
    requiredConcepts: ["public meeting", "the footpath"],
    prompt: "When is the public meeting about the footpath?",
    answer: ["It", "is", "in", "the", "council", "hall", "tonight."],
    distractor: "were",
  },
  {
    domain: "arts-culture",
    situation: "a music teacher moves a recital to another hall",
    participantRoles: ["music teacher", "performer"],
    noveltyKey: "music-recital-hall-change",
    requiredConcepts: ["the recital", "another hall"],
    prompt: "Where is the recital now?",
    answer: ["It", "moved", "to", "the", "smaller", "hall", "upstairs."],
    distractor: "moves",
  },
  {
    domain: "workplace-business",
    situation: "an office supervisor explains how an employee claims an expense",
    participantRoles: ["supervisor", "new hire"],
    noveltyKey: "office-expense-claim-deadline",
    requiredConcepts: ["the expense form", "Friday"],
    prompt: "When is the expense form due?",
    answer: ["Send", "the", "signed", "form", "to", "payroll", "Friday."],
    distractor: "sent",
  },
  {
    domain: "health-wellbeing",
    situation: "a nutrition workshop explains planning meals for a week",
    participantRoles: ["dietitian", "workshop participant"],
    noveltyKey: "nutrition-workshop-meal-planning",
    requiredConcepts: ["meal plan", "grocery list"],
    prompt: "What goes on the grocery list?",
    answer: ["Everything", "on", "the", "weekly", "meal", "plan", "counts."],
    distractor: "count",
  },
  {
    domain: "campus-academics",
    situation: "a professor extends a course reading deadline",
    participantRoles: ["professor", "seminar member"],
    noveltyKey: "course-reading-deadline-extension",
    requiredConcepts: ["the reading", "one day"],
    prompt: "How long is the reading extended?",
    answer: ["You", "have", "one", "more", "day", "to", "finish."],
    distractor: "had",
  },
  {
    domain: "history-social-change",
    situation: "a heritage society records an old neighbourhood tradition",
    participantRoles: ["society archivist", "long-time resident"],
    noveltyKey: "heritage-society-tradition-recording",
    requiredConcepts: ["the recording", "two visits"],
    prompt: "How many visits were recorded?",
    answer: ["They", "recorded", "two", "visits", "for", "the", "archive."],
    distractor: "record",
  },
  {
    domain: "services-travel",
    situation: "a station kiosk explains a refund for a delayed train",
    participantRoles: ["kiosk attendant", "passenger"],
    noveltyKey: "station-delay-refund-process",
    requiredConcepts: ["the refund", "a delay"],
    prompt: "How do I get the refund?",
    answer: ["Show", "the", "delay", "notice", "at", "the", "kiosk."],
    distractor: "shown",
  },
  {
    domain: "science-environment",
    situation: "a climate study group plans a habitat count",
    participantRoles: ["study leader", "field helper"],
    noveltyKey: "climate-group-habitat-count",
    requiredConcepts: ["the count", "early morning"],
    prompt: "When does the count begin?",
    answer: ["It", "begins", "in", "the", "early", "morning", "hours."],
    distractor: "began",
  },
] as const;

export function alternativeWritingPlanFixture(): WritingGenerationPlan {
  const situations = alternativeSituations.map((situation) => ({
    domain: situation.domain,
    situation: situation.situation,
    participantRoles: [...situation.participantRoles] as [string, string],
    noveltyKey: situation.noveltyKey,
    requiredConcepts: [...situation.requiredConcepts],
    distinguishesFrom: [],
  })) as unknown as WritingGenerationPlan["buildASentence"]["situations"];
  return {
    version: "cross-set-diversity-v1" as const,
    kind: "writing" as const,
    buildASentence: { situations },
    email: {
      domain: "services-travel" as const,
      situation: "asking a hotel to hold a bag after check-out",
      recipientRole: "hotel front desk",
      communicativeActs: [
        "explain the late flight",
        "ask about bag storage",
        "ask for a pickup time",
      ] as [string, string, string],
      noveltyKey: "hotel-bag-storage-after-checkout",
      requiredConcepts: ["bag storage", "late flight", "pickup time"],
      distinguishesFrom: [],
    },
    academicDiscussion: {
      domain: "science-environment" as const,
      proposition:
        "campus buildings should cut energy use to meet climate targets",
      competingValues: [
        "lower running costs",
        "comfort during long study hours",
      ] as [string, string],
      noveltyKey: "campus-energy-climate-targets",
      requiredConcepts: ["energy use", "climate targets", "running costs"],
      distinguishesFrom: [],
    },
  };
}

/**
 * Splits a reply into the frame/tiles/answers triple a conforming Build a Sentence Item has. The
 * first and last words become the frame's fixed text; everything between them is one blank each.
 */
function conformingReply(
  reply: readonly string[],
  distractor: string,
): { frame: string; tiles: string[]; answers: string[][] } {
  const middle = reply.slice(1, -1);
  return {
    frame: `${reply[0]} ${middle.map(() => "___").join(" ")} ${reply[reply.length - 1]}`,
    tiles: [...middle, distractor],
    answers: [[...middle]],
  };
}

export function alternativeWritingSetFixture(): WritingSet {
  return {
    id: "wri-alternative",
    kind: "writing" as const,
    source: "generated" as const,
    createdAt: "2026-08-01T00:00:00Z",
    buildASentence: {
      items: alternativeSituations.map((situation, index) => ({
        id: `bas-${index + 1}`,
        prompt: situation.prompt,
        // A conforming frame Item, because this fixture stands in for real generate output and runs
        // through the Build a Sentence conformance gate. The frame holds the reply's first and last
        // words, so no tile carries a sentence-initial capital or a full stop; every word between
        // them is a blank, and one extra tile is the distractor, so there is one blank fewer than
        // tiles.
        ...conformingReply(situation.answer, situation.distractor),
      })),
    },
    email: {
      id: "email-1",
      scenario:
        "Your flight leaves late and you need somewhere to keep a bag at the front desk after check-out.",
      to: "frontdesk@hotel.example",
      subject: "Holding a bag after check-out",
      bullets: [
        "Explain the late flight.",
        "Ask about bag storage.",
        "Ask for a pickup time.",
      ],
      timeLimitSec: 420 as const,
      wordGuidance: { min: 80 as const, max: 120 as const },
    },
    academicDiscussion: {
      id: "disc-1",
      courseTitle: "Building Systems",
      professorName: "Dr. Okafor",
      professorPost:
        "Older campus buildings waste a lot of heat. " +
        "Should the university cut energy use to meet its climate targets before it buys new equipment?",
      studentPosts: [
        {
          name: "Ada",
          post: "Cutting energy use lowers running costs and frees money for teaching.",
        },
        {
          name: "Ben",
          post: "Comfort during long study hours matters more than the running costs saved.",
        },
      ],
      timeLimitSec: 600 as const,
      minWords: 100 as const,
    },
  };
}
import type {
  SpeakingGenerationPlan,
  SpeakingSet,
  WritingGenerationPlan,
  WritingSet,
} from "@toefl-prep/shared";
