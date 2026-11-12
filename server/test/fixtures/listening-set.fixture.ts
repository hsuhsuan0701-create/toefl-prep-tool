import type { ListeningSet } from "@toefl-prep/shared";

// A minimal schema-valid Listening Set. Only the counts zod actually pins are honoured (4 options per
// listen_choose item, 2 speakers per conversation, 2 questions per conversation/announcement, 4 per
// academic talk); module COMPOSITION counts (spec §6.3's recommended table: router 10/3/3/1, lower
// 5/2/2/0, upper 5/2/0/3) are enforced by the Verifier + generation skill, not zod, so the router here
// carries one of each Task Type and lower/upper stay as small as the schema allows.
//
// Every answer-bearing string (utterance, transcript text, explanation prose) is chosen so it never
// occurs as a substring of anything stripAnswers keeps (audio path, role, accent, setting, discipline,
// option text, stem). That is what makes the leak scan in schemas.listening.test.ts a real test rather
// than a coincidence: if a secret ever survives the strip, the scan sees it.

// Appears ONLY inside generationPlan, which stripAnswers drops wholesale — so the leak scan can
// assert on plan content instead of just on the field name.
export const LISTENING_PLAN_MARKER = "plan-only-listening-provenance-marker";

function mcq(id: string, correct: string) {
  return {
    id,
    stem: `Stem for ${id}?`,
    options: [
      { id: "a", text: "Option A" },
      { id: "b", text: "Option B" },
      { id: "c", text: "Option C" },
    ],
    correctOptionId: correct,
    skill: "detail" as const,
    explanationZh: `題目 ${id}:正確答案是 ${correct},因為錄音明確提到;其他選項與內容不符。`,
  };
}

// Every Speaker is `provider: "gemini"` because that is what listeningGenerator's
// assignSpeakerRendering now casts unconditionally, and what listeningAudioRenderer's plan-time
// guard requires — a Set with any other provider is rejected before a single synthesis call.
function speaker(id: string, role: string, gender: "male" | "female", accent: "north-american" | "british" | "australian") {
  return {
    id, role, gender, accent,
    voice: `${id}-voice-secret`,
    provider: "gemini" as const,
  };
}

const planEntry = (slug: string) => ({
  domain: "campus-academics" as const,
  noveltyKey: `plan-key-${slug}`,
  requiredConcepts: [`plan concept ${slug} alpha`, `plan concept ${slug} beta`],
  distinguishesFrom: [],
});

export const LISTENING_FIXTURE: ListeningSet = {
  id: "lsn-fixture1", kind: "listening", source: "generated", createdAt: "2026-08-09T00:00:00.000Z",
  router: {
    timeLimitSec: 1080,
    listenChoose: [{
      id: "lcr-1", taskType: "listen_choose",
      audio: "stimuli/lsn-fixture1/lcr-01.mp3",
      speaker: speaker("lcr-1-sp", "student", "female", "north-american"),
      utterance: "Would you mind grabbing the door for me quick",
      options: [
        { id: "a", text: "Sure, no problem." },
        { id: "b", text: "It closes at six." },
        { id: "c", text: "I already had one." },
        { id: "d", text: "That sounds delicious." },
      ],
      correctOptionId: "a",
      skill: "function" as const,
      explanationZh: "說話者禮貌請求協助開門,選項 a 是唯一合適的回應;其他選項答非所問。",
    }],
    conversations: [{
      id: "conv-1", taskType: "conversation",
      audio: "stimuli/lsn-fixture1/conv-01.mp3", setting: "campus dining hall",
      speakers: [
        speaker("conv-1-sp1", "student", "male", "british"),
        speaker("conv-1-sp2", "cashier", "female", "australian"),
      ],
      transcript: [
        { speakerId: "conv-1-sp1", text: "Could I still get the lunch special after two o'clock." },
        { speakerId: "conv-1-sp2", text: "We stop serving it at one-thirty, sorry about that." },
      ],
      questions: [mcq("conv-1-q1", "a"), mcq("conv-1-q2", "b")],
    }],
    announcements: [{
      id: "ann-1", taskType: "announcement",
      audio: "stimuli/lsn-fixture1/ann-01.mp3", setting: "student union lobby",
      speaker: speaker("ann-1-sp", "staff member", "female", "north-american"),
      transcript: "Attention residents, the elevator on the east wing will be closed for maintenance starting tomorrow morning until further notice.",
      questions: [mcq("ann-1-q1", "c"), mcq("ann-1-q2", "a")],
    }],
    academicTalks: [{
      id: "talk-1", taskType: "academic_talk",
      audio: "stimuli/lsn-fixture1/talk-01.mp3", discipline: "marine biology",
      speaker: speaker("talk-1-sp", "professor", "male", "british"),
      transcript: "Today we will look at how tidal pools support a surprising range of organisms despite their harsh, constantly changing conditions.",
      questions: [mcq("talk-1-q1", "b"), mcq("talk-1-q2", "a"), mcq("talk-1-q3", "c"), mcq("talk-1-q4", "b")],
    }],
  },
  lowerModule: {
    timeLimitSec: 420,
    listenChoose: [{
      id: "lcr-lo-1", taskType: "listen_choose",
      audio: "stimuli/lsn-fixture1/lcr-lo-01.mp3",
      speaker: speaker("lcr-lo-1-sp", "librarian", "female", "north-american"),
      utterance: "Can you keep it down over here please",
      options: [
        { id: "a", text: "Sorry, I'll be quieter." },
        { id: "b", text: "It's due next Friday." },
        { id: "c", text: "Two floors up." },
        { id: "d", text: "I paid the fine already." },
      ],
      correctOptionId: "a",
      skill: "function" as const,
      explanationZh: "說話者要求安靜,選項 a 是合理的回應;其他選項與請求無關。",
    }],
    conversations: [],
    announcements: [],
    academicTalks: [],
  },
  upperModule: {
    timeLimitSec: 660,
    listenChoose: [],
    conversations: [],
    announcements: [],
    academicTalks: [{
      id: "talk-up-1", taskType: "academic_talk",
      audio: "stimuli/lsn-fixture1/talk-up-01.mp3", discipline: "astronomy",
      speaker: speaker("talk-up-1-sp", "professor", "female", "australian"),
      transcript: "Consider how astronomers infer the composition of distant stars purely from patterns in the light those stars emit.",
      questions: [
        mcq("talk-up-1-q1", "a"), mcq("talk-up-1-q2", "b"),
        mcq("talk-up-1-q3", "c"), mcq("talk-up-1-q4", "a"),
      ],
    }],
  },
  audioProfile: {
    version: "ets-2026-listening-v1",
    provider: "gemini",
    model: "gemini-3.1-flash-tts-preview",
  },
  generationPlan: {
    version: "cross-set-diversity-v1",
    kind: "listening",
    listenChoose: Array.from({ length: 20 }, (_, i) => ({
      ...planEntry(`lcr-${i + 1}`),
      topic: `Plan topic lcr-${i + 1} (${LISTENING_PLAN_MARKER})`,
      speakerRole: `Plan speaker role lcr-${i + 1}`,
    })),
    conversations: Array.from({ length: 7 }, (_, i) => ({
      ...planEntry(`conv-${i + 1}`),
      setting: `Plan setting conv-${i + 1}`,
      speakerRoles: [`Plan speaker role conv-${i + 1}a`, `Plan speaker role conv-${i + 1}b`] as [string, string],
    })),
    announcements: Array.from({ length: 5 }, (_, i) => ({
      ...planEntry(`ann-${i + 1}`),
      setting: `Plan setting ann-${i + 1}`,
      speakerRole: `Plan speaker role ann-${i + 1}`,
    })),
    academicTalks: Array.from({ length: 4 }, (_, i) => ({
      ...planEntry(`talk-${i + 1}`),
      discipline: `Plan discipline talk-${i + 1}`,
      speakerRole: `Plan speaker role talk-${i + 1}`,
    })),
  },
};
