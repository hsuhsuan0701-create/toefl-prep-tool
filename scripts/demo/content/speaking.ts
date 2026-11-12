/**
 * The demo User's spoken Responses, as Ears would have transcribed them (disfluencies kept), and
 * the scores they earned. Keyed by sitting, because one Set is sat twice (the Repeat).
 *
 * Listen and Repeat: `said` departs from the Set's sentence the way this learner's repetitions do:
 * dropped articles and plural or tense endings, a content word swapped for a near neighbour, and
 * long sentences that lose their second half. Each score follows the Listen and Repeat rubric for
 * those changes; the Deductions, notes and Judge Reports are derived from the word diff
 * (reports.ts).
 *
 * Interview answers were written for this demo against each Set's own questions. Nothing here comes
 * from ETS or from anyone's real practice. "Day 18" on an entry means 18 days before `today`, as in
 * seed.ts's history.
 */
import type { JudgedResponse, RepeatResponse } from "../reports.js";

/** A Listen and Repeat Item the User never recorded in a Simulation: scored 0 as a skip. */
export const SKIPPED = "skipped";
/** A recording Ears heard nothing in: scored a deterministic 0. */
export const NO_SPEECH = "no-speech";
/** A recording whose transcription failed every automatic retry: the User can retry it. */
export const TRANSCRIPTION_FAILED = "transcription-failed";

export type SpeakingContent = {
  setId: string;
  repeat: Record<string, RepeatResponse | typeof SKIPPED>;
  interview: Record<string, JudgedResponse | typeof NO_SPEECH | typeof TRANSCRIPTION_FAILED>;
};

const COMMUTE = "spk-307f62cd";

export const SPEAKING = {
  // Day 18, first Speaking Drill.
  commuteDrill: {
    setId: COMMUTE,
    repeat: {
      "lr-1": { said: "The stage manager hand me the cue sheet first.", score: 4 },
      "lr-2": { said: "The cue sheet and crew list arrives before the rehearsal.", score: 3, openai: 3.5 },
      "lr-3": { said: "Check the angle and look each spotlight in your station.", score: 3 },
      "lr-4": { said: "We move through each lighting station, and you take a note.", score: 3 },
      "lr-5": { said: "Before the curtain rises, we, um, test the channel.", score: 2 },
      "lr-6": { said: "The backup bulbs sit inside, um... a drawer.", score: 2, mispronounced: ["bulbs"] },
      "lr-7": { said: "The assistant who is, uh, should check her angle.", score: 2 },
    },
    interview: {
      "int-1": {
        text: "Um, usually I take bus to the campus. I live near the, uh, the night market, so I walk to the bus stop on Daxue Road and take the number... number 12. It take about twenty minutes. Sometimes if I'm late, um, I take scooter.",
        final: 2.5,
        dims: [2.5, 2.5, 3, 2.5],
        deductions: [
          ["usually I take bus to the campus", "'Bus' needs 'the', and 'campus' does not.", "usually I take the bus to campus", "grammar"],
          ["It take about twenty minutes", "Third-person -s dropped.", "It takes about twenty minutes", "grammar"],
          ["I take scooter", "Answers the question but stops there; one sentence on why the bus is your usual choice would develop it.", "I ride my scooter, but most days the bus is easier because parking near campus is hard to find", "elaboration"],
        ],
        zh: "兩個問題（怎麼去、搭哪一路公車）都有回答，但每一點只講一句，內容偏少。冠詞是主要問題：take the bus、to campus（不用 the）。It takes 的 -s 也掉了。可以多說一句為什麼平常選公車，回答就會完整很多。",
        rewrite: "Most days I take the bus to campus. I live near the night market, so I walk about five minutes to the stop on Daxue Road and catch the number 12, which takes around twenty minutes. If I'm running late, I ride my scooter instead, but I try not to, because parking near the engineering building is really hard to find in the morning.",
      },
      "int-2": {
        text: "Last month there was a construction on Daxue Road, so the bus stop was, uh, moved. I didn't know that, so I wait at the old stop for... for a long time. Then I asked a store owner and she told me where is the new stop. So I walked to there and I was late for my class.",
        final: 2.5,
        judges: { gemini: 2.5, openai: 3 },
        dims: [2.5, 2.5, 3, 2.5],
        deductions: [
          ["there was a construction", "'Construction' is uncountable here, so no 'a'.", "there was construction", "grammar"],
          ["I wait at the old stop", "Past-tense story, present-tense verb.", "I waited at the old stop", "grammar"],
          ["she told me where is the new stop", "An embedded question keeps statement word order.", "she told me where the new stop was", "grammar"],
        ],
        zh: "有說出一個具體的經驗，故事的順序也清楚，這是好的開始。不過講過去的事情時時態常常跑掉（I waited），間接問句也要用直述句語序：where the new stop was。下次可以加一句當時的感受或之後怎麼改變習慣，內容會更豐富。",
        rewrite: "Last month the city started repaving Daxue Road, and they moved my bus stop one block away. Nobody told me, so I waited at the old stop for almost fifteen minutes before I realized something was wrong. A woman at the convenience store told me where the new stop was, so I walked over there, but I'd already missed two buses and arrived late to my lab. After that, I started checking the bus app every morning before I leave.",
      },
      "int-3": {
        text: "I usually prefer the cheapest way. Because I'm a student and I don't have much money, so saving money is more important for me. For example, the high speed rail is faster but it's, um, like three times more expensive than the bus, so when I go back to my hometown I always take the bus, even it takes four hours. I can sleep or watch video on the bus, so it's not really wasting time.",
        final: 3,
        dims: [3, 2.5, 3.5, 3],
        deductions: [
          ["Because I'm a student and I don't have much money, so saving money", "'Because' and 'so' both mark the same link; use one.", "Because I'm a student without much money, saving money matters more to me", "grammar"],
          ["even it takes four hours", "'Even' alone cannot start a clause.", "even though it takes four hours", "grammar"],
          ["watch video", "A countable noun needs a plural or an article.", "watch videos", "grammar"],
        ],
        zh: "立場清楚，高鐵和客運的價格比較是很好的具體例子，最後說在車上可以睡覺、看影片，也回應了「浪費時間」的問題。扣分主要在文法：because 和 so 不要同時用、even though 不能只說 even、videos 要加 s。",
        rewrite: "I usually go for the cheapest option. I'm a student, so saving money matters more to me than saving an hour. For example, when I go back to my hometown, the high-speed rail is about three times as expensive as the bus, so I always take the bus, even though it takes four hours. And I don't really see it as wasted time, because I can sleep or catch up on videos during the ride.",
      },
      "int-4": {
        text: "I think making it cheaper is better. Um, because many people like students and old people, they need to take bus every day, and if it's cheaper they can save a lot. Faster is also good but, uh... I think cheaper help more people.",
        final: 2.5,
        dims: [2, 2.5, 3, 2.5],
        deductions: [
          ["they need to take bus every day", "Missing article.", "they need to take the bus every day", "grammar"],
          ["I think cheaper help more people", "Ends by repeating the claim instead of saying why faster routes help fewer people.", "I think lower fares would help more people, because a few minutes saved matters less than a fare someone can't afford", "elaboration"],
        ],
        zh: "有回答選哪一個，也有提到學生和長者這兩個族群，但後半段停在「快也不錯，但便宜幫助更多人」，沒有說明為什麼。這題是要你比較兩個選項，可以補一句：省幾分鐘對大部分人影響不大，但票價負擔不起就完全不能搭。",
        rewrite: "I think making routes cheaper would help more commuters. Students and older people take the bus every day, and for them the fare adds up quickly over a month. A faster route is nice, but saving five minutes doesn't change whether someone can get to work or class. A fare they can't afford does. So if the office can only do one thing, lowering the price reaches more people.",
      },
    },
  },

  // Day 14, first Speaking Simulation. Sentence 6 was never recorded (a skip); the OpenAI Judge
  // scored the third answer from its transcript (Text Fallback).
  artsSimulation: {
    setId: "spk-1ba26e29",
    repeat: {
      "lr-1": { said: "Please sign the sheet at front table.", score: 4 },
      "lr-2": { said: "The sign-in sheet and pen is on the table.", score: 3 },
      "lr-3": { said: "Check the sheet, then walk to the citation shelf.", score: 3 },
      "lr-4": { said: "The citation guide shelf sit beside the whiteboard, and tutors use it.", score: 3, openai: 3.5 },
      "lr-5": { said: "When student asks about, um, the source... point to shelf.", score: 2, mispronounced: ["sources"] },
      "lr-6": SKIPPED,
      "lr-7": { said: "The appointment log, which is near the printer, is... filled.", score: 2 },
    },
    interview: {
      "int-1": {
        text: "Not very often, maybe once in two months. Usually I go to the Riverside Livehouse, it's a small music bar near my school, because my friend plays guitar in a band and they perform there. Sometimes I also go to the, uh, the city cultural center when there's a free concert.",
        final: 3,
        dims: [3, 3, 3.5, 3],
        deductions: [
          ["maybe once in two months", "Unidiomatic frequency phrase.", "maybe once every two months", "vocab"],
          ["the Riverside Livehouse, it's a small music bar", "Two full clauses joined by a comma.", "the Riverside Livehouse, a small music bar", "grammar"],
        ],
        zh: "頻率和地點都有回答，還補充了為什麼常去那家（朋友在樂團），內容完整。注意頻率的說法是 once every two months，以及兩個完整句子不要只用逗號連接。",
        rewrite: "Not very often, maybe once every two months. I usually go to Riverside Livehouse, a small music bar near my school, because a friend of mine plays guitar in a band that performs there. When the city cultural center has a free concert, I go there too.",
      },
      "int-2": {
        text: "Recently I went to my friend's concert at the livehouse. It was, um, special because the power was cut in the middle. The lights all off and, uh, everyone was quiet, then the singer just keep singing without microphone. And the audience, we used our phone light. It was very... touching.",
        final: 2.5,
        dims: [3, 2.5, 3, 2],
        deductions: [
          ["The lights all off", "Missing verb.", "The lights all went off", "grammar"],
          ["the singer just keep singing without microphone", "Tense slip and a missing article.", "the singer just kept singing without a microphone", "grammar"],
          ["It was very... touching.", "The moment is described, but the answer stops before saying why it stuck with you.", "It was touching, because for a few minutes the whole room felt like part of the show.", "elaboration"],
        ],
        zh: "停電後歌手繼續清唱、觀眾用手機燈光這個例子非常生動，是很好的素材。可惜文法錯誤比較多：lights went off 少了動詞、kept singing 的時態、a microphone 的冠詞。最後一句可以說明為什麼印象深刻，而不是停在 touching。",
        rewrite: "A few weeks ago I went to my friend's show at the livehouse, and halfway through, the power went out. The lights went off and the room got completely quiet, but the singer just kept going without a microphone. Everyone turned on their phone flashlights and held them up. It stuck with me because for those ten minutes the audience felt like part of the performance, not just people watching it.",
      },
      "int-3": {
        text: "I think the price should be capped. Because if the ticket is too expensive, the students and, um, the young people cannot go, and the arts will become only for rich people. But the venue also need money... maybe the government can help them. So I agree to cap the price.",
        final: 2.5,
        dims: [2.5, 2.5, 3, 2.5],
        openaiTextFallback: true,
        deductions: [
          ["But the venue also need money", "Subject-verb agreement.", "But the venues also need money", "grammar"],
          ["maybe the government can help them", "Raises the strongest counterpoint and then leaves it; say how the shortfall would be covered.", "maybe the town could cover the difference with a small grant for each capped show", "elaboration"],
          ["So I agree to cap the price.", "'Agree to' means consenting to do something; for an opinion use 'agree with'.", "So I agree with capping prices.", "vocab"],
        ],
        reconciliation:
          "One Judge could not use the recording and scored the transcript and delivery notes instead, so its reading says less about pace and pronunciation. Both Judges still placed the answer at 2.5, and the Arbiter's own reading agreed.",
        zh: "立場很清楚，也有想到場館需要經費這個反方論點，這是好的。但提出反方之後只說 maybe the government can help，沒有說明具體怎麼做，論證就停住了。注意 agree with（同意某觀點）和 agree to（同意去做某事）的差別。",
        rewrite: "I'd support a cap on ticket prices. If tickets get too expensive, students and young people are the first to stop going, and local arts end up as something only wealthier residents enjoy. Venues do need money for better shows, but the town could cover part of the difference, for example with a small grant for each performance that keeps its price under the cap. That way audiences stay broad and venues aren't left short.",
      },
      "int-4": {
        text: "Yes, I think the town should put more money to small venues. Small venues are where new artists start, like my friend's band. If they close, there is no place for them to practice performing. I would recommend the government give them money for, um, equipment like sound system, because it's very expensive for a small place.",
        final: 3,
        judges: { gemini: 3, openai: 3.5 },
        dims: [3.5, 3, 3, 3],
        deductions: [
          ["put more money to small venues", "Wrong preposition with 'put money'.", "put more money into small venues", "grammar"],
          ["equipment like sound system", "Missing plural.", "equipment like sound systems", "grammar"],
        ],
        zh: "有給出明確建議（補助音響設備），也用朋友的樂團說明小場地的重要，回答有方向。小錯誤：put money into、sound systems。可以再多說一點補助的方式，例如每年開放申請一次，建議會更具體。",
        rewrite: "Yes, I think the town should put more funding into small venues. They're where new artists get their start, like my friend's band, and if they close, young musicians lose the only place they can practice performing in front of people. I'd recommend grants for equipment in particular, such as sound systems, because that's the biggest cost a small venue can't cover on its own.",
      },
    },
  },

  // Day 11, Speaking Drill. The second answer's transcription failed every automatic retry, so the
  // Attempt has no band until the User retries it.
  groceryDrill: {
    setId: "spk-c68f245c",
    repeat: {
      "lr-1": { said: "First, let's check the walk-in cooler together.", score: 5 },
      "lr-2": { said: "The temperature log and door seal needs checking.", score: 4 },
      "lr-3": { said: "Sign the cooler log and switch off the lights before you leave.", score: 4 },
      "lr-4": { said: "We scrub the mixer bowls first, and you dry every one.", score: 3 },
      "lr-5": { said: "After the bowls are dry, seal every flour bin.", score: 3, openai: 3.5 },
      "lr-6": { said: "Once the surface is clean, count the... and lock the register.", score: 2 },
      "lr-7": { said: "The drawer amount you counted should match what was recorded in the morning.", score: 3 },
    },
    interview: {
      "int-1": {
        text: "Yes, I usually write a list. Because if I don't, I always buy too many snacks and forget the important things, like eggs or, um, laundry detergent. My roommate and I share one list, so we don't buy the same thing two times.",
        final: 3,
        dims: [3, 3, 3.5, 3],
        deductions: [
          ["Because if I don't, I always buy too many snacks", "A 'because' clause on its own is a fragment.", "If I don't, I always buy too many snacks", "grammar"],
          ["we don't buy the same thing two times", "'Twice' is the natural word.", "we don't buy the same thing twice", "vocab"],
        ],
        zh: "有回答會不會寫清單，也說明了原因（不寫就會亂買零食、忘記重要的東西），還補充和室友共用清單，內容很自然。注意 because 子句不能單獨成句，two times 口語中通常說 twice。",
        rewrite: "Yes, I almost always write one. If I don't, I end up buying too many snacks and forgetting the things I actually need, like eggs or laundry detergent. My roommate and I share a single list, which also stops us from buying the same thing twice.",
      },
      "int-2": TRANSCRIPTION_FAILED,
      "int-3": {
        text: "Last week I wrote the list on my phone, but I forgot to add rice, because I noticed it was finished only after I came back. So I think the second view is more true. Even if you are careful, you can still forget something, because you write the list based on what you remember, not what you really check in the kitchen.",
        final: 3,
        judges: { gemini: 3, openai: 3.5 },
        dims: [3.5, 3, 3, 3],
        deductions: [
          ["I noticed it was finished only after I came back", "'Finished' sounds unnatural for food that has run out.", "I only noticed we were out of it after I got back", "vocab"],
          ["So I think the second view is more true.", "'More true' is usually 'closer to the truth'.", "So I think the second view is closer to the truth.", "vocab"],
        ],
        zh: "例子（忘了買米）和你的看法有連在一起，而且最後一句解釋了原因：清單是靠記憶寫的，不是實際檢查廚房，這個觀點很有說服力。用字上 run out of 比 finished 自然，more true 可以改成 closer to the truth。",
        rewrite: "Last week I made my list on my phone but left off rice, and I only noticed we were out of it after I got home. So I think the second view is closer to the truth. However careful you are, a list is only as good as your memory, because most people write it from what they remember rather than by actually checking the kitchen.",
      },
      "int-4": {
        text: "It depends on what is missing. If it's something I need every day like rice, I go back right away. Last time I just went to the convenience store downstairs and bought a small bag, it was more expensive but I needed it for dinner. For snacks or something not important, I just wait for the next trip.",
        final: 3,
        dims: [3.5, 3, 3, 3],
        deductions: [
          ["bought a small bag, it was more expensive", "Two full sentences joined by a comma.", "bought a small bag. It was more expensive", "grammar"],
        ],
        zh: "回答有區分情況（每天需要的東西和零食），也說出上次實際怎麼做，兩個問題都照顧到了。逗號連接兩個句子的問題又出現了，說話時可以在這裡停頓一下，分成兩句。",
        rewrite: "It depends on what's missing. If it's something I need every day, like rice, I go back right away. Last time that's exactly what I did: I went down to the convenience store below my building and bought a small bag. It cost more than at the supermarket, but I needed it for dinner. For snacks or anything that isn't urgent, I just wait for my next regular trip.",
      },
    },
  },

  // Day 8, Speaking Simulation. The User froze on the third question: a recording with no speech.
  exerciseSimulation: {
    setId: "spk-4ed5798a",
    repeat: {
      "lr-1": { said: "Line up each luggage cart near the elevator.", score: 4 },
      "lr-2": { said: "Check each trainee uniform and name tag before rounds.", score: 4 },
      "lr-3": { said: "Sort and match the room key packet with the tour group's list.", score: 3, mispronounced: ["manifest"] },
      "lr-4": { said: "Open the concierge stand lost tag log, and record the number.", score: 3, mispronounced: ["concierge"] },
      "lr-5": { said: "After you match the key packets, put them to the guest folder.", score: 3 },
      "lr-6": { said: "Before the tour group arrive, make sure every... the cart is near.", score: 2, openai: 2.5 },
      "lr-7": { said: "Guest check in... during the rush get the keys.", score: 2 },
    },
    interview: {
      "int-1": {
        text: "I usually do a neck stretch and, um, roll my shoulders, because I sit in front of laptop for a long time. I try to do it every hour, but honestly, when I'm busy I forget and maybe only do it two or three times in the whole afternoon.",
        final: 3,
        dims: [3, 3, 3.5, 3],
        deductions: [["in front of laptop", "Missing article or possessive.", "in front of my laptop", "grammar"]],
        zh: "動作和頻率都有說明，最後還誠實補充忙的時候會忘記，讓回答更真實。注意 in front of my laptop 要有冠詞或所有格。語速可以再穩定一點，句子中間的停頓少一些。",
        rewrite: "I usually do a quick neck stretch and roll my shoulders, since I spend hours in front of my laptop. I try to do it every hour, but honestly, on busy days I forget, and it ends up being two or three times in a whole afternoon.",
      },
      "int-2": {
        text: "Last Sunday I studied in the library for about five hours to prepare for my statistics exam. When I stood up, my back was very stiff and my leg was, uh, sleeping. So I walked around the bookshelves for ten minutes and did some stretch, and then I felt better and continued.",
        final: 3,
        judges: { gemini: 3.5, openai: 3 },
        dims: [3.5, 3, 3, 3],
        deductions: [
          ["my leg was, uh, sleeping", "The idiom is 'my leg had fallen asleep'.", "my leg had fallen asleep", "vocab"],
          ["did some stretch", "A countable noun needs a plural.", "did some stretches", "grammar"],
        ],
        zh: "故事有時間（上週日）、原因（準備統計考試）、結果和你的反應，結構完整。my leg was sleeping 是中文直翻，英文說 my leg had fallen asleep；stretch 當名詞時要用複數 stretches。",
        rewrite: "Last Sunday I spent about five hours in the library preparing for my statistics exam. When I finally stood up, my lower back was stiff and my left leg had fallen asleep. I walked around the bookshelves for about ten minutes and did a few stretches by the window, and after that I could concentrate again for the rest of the evening.",
      },
      "int-3": NO_SPEECH,
      "int-4": {
        text: "I think it should be up to the individual, but schools can remind people. Everyone's body and schedule is different, for example in a exam week I want to keep studying. But a reminder, like a short message in the middle of a long class, is helpful because many people just forget, like me.",
        final: 3,
        dims: [3.5, 3, 3, 3],
        deductions: [
          ["Everyone's body and schedule is different", "Two subjects joined by 'and' take a plural verb.", "Everyone's body and schedule are different", "grammar"],
          ["in a exam week", "'An' before a vowel sound.", "in an exam week", "grammar"],
        ],
        zh: "你選了折衷的立場（個人決定，但學校可以提醒），並用考試週的例子說明，最後連結到自己也會忘記，前後呼應得很好。注意 an exam 的冠詞，以及兩個名詞當主詞時動詞要用 are。",
        rewrite: "I think it should stay up to the individual, but schools can make it easier to remember. People's bodies and schedules are different; during exam week, for instance, I'd rather keep going than stop on a timer. A gentle reminder, though, like a short pause halfway through a long class, would help a lot of people, because most of us simply forget, myself included.",
      },
    },
  },

  // Day 6, the Speaking section of the completed Full-Test Run.
  windDownFullTest: {
    setId: "spk-eabf67bc",
    repeat: {
      "lr-1": { said: "The sign-in sheet is right by the warehouse door.", score: 4 },
      "lr-2": { said: "Canned goods and box pasta go on the far shelf.", score: 4 },
      "lr-3": { said: "We sort the canned goods by expiration each morning.", score: 3, mispronounced: ["expiration"] },
      "lr-4": { said: "Check each piece of produce for damage, and put the spoiled one aside.", score: 3 },
      "lr-5": { said: "After you check the produce, place it on the shelf.", score: 3, openai: 3.5 },
      "lr-6": { said: "The volunteer sign-in sheet by the door... the shift hours.", score: 2 },
      "lr-7": { said: "The distribution line, which open at ten... outside.", score: 2 },
    },
    interview: {
      "int-1": {
        text: "In the last half hour, I usually turn on the night mode on my phone and watch some short videos, but I know it's not very good. Sometimes I read a few pages of a novel instead. For bedtime, on weekdays I sleep around midnight, but on weekends I usually stay up until two, so it's not the same.",
        final: 3,
        dims: [3.5, 3, 3, 3],
        deductions: [
          ["watch some short videos, but I know it's not very good", "A vague judgement; say what isn't good about it.", "watch some short videos, though I know the screen keeps me awake longer", "elaboration"],
          ["I sleep around midnight", "'Sleep' describes the state; 'go to bed' names the time.", "I go to bed around midnight", "vocab"],
        ],
        zh: "兩個問題都有回答：睡前會開夜間模式看短片、有時看小說，週末會晚睡到兩點。可以改進的是 it's not very good 太模糊，直接說螢幕讓你比較晚睡著，回答會更具體。sleep around midnight 改成 go to bed around midnight。",
        rewrite: "In the last half hour I usually switch my phone to night mode and watch a few short videos, although I know the screen keeps me awake longer. Some nights I read a few pages of a novel instead. My bedtime isn't consistent: I go to bed around midnight on weekdays, but on weekends I often stay up until two.",
      },
      "int-2": {
        text: "Two weeks ago I had a presentation in my seminar and it didn't go well, the professor asked many questions I couldn't answer. That night I couldn't stop thinking about it, so I didn't read or anything, I just scrolled my phone until almost three. The next day I was very tired in my lab.",
        final: 3.5,
        judges: { gemini: 3, openai: 3.5 },
        dims: [4, 3, 3.5, 3.5],
        deductions: [
          ["it didn't go well, the professor asked many questions", "Two full sentences joined by a comma.", "it didn't go well: the professor asked many questions", "grammar"],
          ["I just scrolled my phone", "'Scroll' needs 'through' here.", "I just scrolled through my phone", "grammar"],
        ],
        zh: "故事完整：發生什麼事、當晚怎麼打亂作息、隔天的影響都有說到，內容很有真實感。語言上要注意逗號連接兩個完整句子，以及 scroll through my phone 的介系詞。",
        rewrite: "Two weeks ago I gave a presentation in my seminar, and it didn't go well: the professor asked several questions I couldn't answer. That night I kept replaying it in my head, so instead of reading I scrolled through my phone until almost three. The next day I was exhausted in the lab and made two mistakes in my data entry.",
      },
      "int-3": {
        text: "I agree that screen use is the most important. From my experience, when I read a book before sleeping I fall asleep in maybe fifteen minutes, but after watching videos, um, it takes almost one hour. A consistent bedtime is also good, but if you use phone in bed, you still can't sleep even at the same time.",
        final: 3.5,
        dims: [4, 3, 3.5, 3.5],
        deductions: [
          ["if you use phone in bed", "Missing possessive or article.", "if you use your phone in bed", "grammar"],
          ["you still can't sleep even at the same time", "Unclear what 'at the same time' refers to.", "you still can't fall asleep, even if you go to bed at the same time every night", "coherence"],
        ],
        zh: "用自己看書和看影片的入睡時間對比（十五分鐘和快一小時）來支持論點，非常有說服力。最後一句想表達「就算固定時間上床，滑手機還是睡不著」，但 at the same time 意思不清楚，要說完整。",
        rewrite: "I'd say screen use matters most. In my own experience, when I read before bed I fall asleep in about fifteen minutes, but after watching videos it takes me close to an hour. A consistent bedtime helps too, but if you're on your phone in bed, you can lie down at the same time every night and still not fall asleep.",
      },
      "int-4": {
        text: "Yes, I think they should, but not force. For example, schools can avoid sending emails or homework notice after ten p.m., so students don't check their phone late. And they can give some simple tips in the orientation, like keep the phone out of bed.",
        final: 3.5,
        dims: [4, 3, 3.5, 3],
        deductions: [
          ["I think they should, but not force", "'Force' needs an object.", "I think they should encourage it, but not force anyone", "grammar"],
          ["homework notice", "Plural needed.", "homework notices", "grammar"],
        ],
        zh: "建議很具體（晚上十點後不寄信、新生訓練給小提示），而且是學校真的做得到的事，這點很好。開頭 but not force 文法不完整，要說 but not force anyone to do it。",
        rewrite: "Yes, I think they should encourage it, without forcing anyone. Schools could stop sending emails and homework notices after 10 p.m., so students aren't pulled back to their phones late at night. They could also include a few simple tips in orientation, like charging your phone outside the bedroom.",
      },
    },
  },

  // Day 3, a Repeat: the commute Set again, fifteen days after the first Drill.
  commuteRepeat: {
    setId: COMMUTE,
    repeat: {
      "lr-1": { said: "The stage manager hands me the cue sheets first.", score: 4 },
      "lr-2": { said: "The cue sheet and the crew list arrive before the rehearsal.", score: 4 },
      "lr-3": { said: "Check the angle and lock each spotlight at the station.", score: 4 },
      "lr-4": { said: "We move through each lighting board and you write notes.", score: 3 },
      "lr-5": { said: "Before the curtain rises, we test every intercom channel.", score: 3, openai: 3.5 },
      "lr-6": { said: "The backup bulbs sit inside a... a locked drawer.", score: 2 },
      "lr-7": { said: "The assistant who is assigned to, um, should check angle.", score: 2 },
    },
    interview: {
      "int-1": {
        text: "Most days I take the bus to campus. I live near the night market, so I walk about five minutes to the stop on Daxue Road and take the number 12. It's around twenty minutes, but in the morning it can be thirty because of traffic. If I'm late, I ride my scooter, but parking near campus is, um, hard to find.",
        final: 3,
        dims: [3.5, 3, 3.5, 3],
        deductions: [
          ["It's around twenty minutes", "'It' has no clear reference; name the ride.", "The ride is around twenty minutes", "vocab"],
          ["parking near campus is, um, hard to find", "A filler just before the last point slows the ending.", "parking near campus is hard to find", "pronunciation-proxy"],
        ],
        zh: "比上次完整很多：路線、公車號碼、尖峰時間的差別都講到了，冠詞也大多正確。可以再改進的是結尾前的停頓，以及 It's around twenty minutes 主詞不清楚，改成 The ride is around twenty minutes。",
        rewrite: "Most days I take the bus to campus. I live near the night market, so I walk about five minutes to the stop on Daxue Road and catch the number 12. The ride is usually twenty minutes, but in the morning rush it can stretch to thirty. When I'm running late I ride my scooter instead, though parking near campus is hard to find.",
      },
      "int-2": {
        text: "Last month the city was repairing Daxue Road, so they moved my bus stop. I didn't notice the sign, so I waited at the old stop for maybe fifteen minutes. Then a woman from the convenience store told me the new stop is one block away. I walked there but I already missed two buses, so I was late for my lab.",
        final: 3,
        dims: [3.5, 3, 3, 3],
        deductions: [
          ["told me the new stop is one block away", "Reported speech in a past story shifts the verb back.", "told me the new stop was one block away", "grammar"],
          ["I walked there but I already missed two buses", "The earlier of two past events needs the past perfect.", "I walked there, but I had already missed two buses", "grammar"],
        ],
        zh: "這次的故事有時間、地點和結果，細節也比上次具體（等了十五分鐘、錯過兩班車）。文法上要注意過去事件的時態：轉述時用 was，比另一件事更早發生的要用 had already missed。",
        rewrite: "Last month the city was resurfacing Daxue Road, and my stop was moved a block north. I didn't see the notice, so I waited at the old stop for about fifteen minutes. Eventually a woman from the convenience store told me the stop had moved. By the time I walked over, I had already missed two buses, and I got to my lab twenty minutes late. Since then I check the bus app before I leave home.",
      },
      "int-3": {
        text: "I usually choose the cheaper way. I'm a student, so saving money matters more to me than saving one hour. For example, when I go back to my hometown, the high speed rail costs about three times more than the bus. So I always take the bus, even though it takes four hours. Actually I don't think it's wasting time, because I can sleep or review my notes on the bus.",
        final: 3.5,
        judges: { gemini: 3.5, openai: 3.5 },
        dims: [4, 3, 4, 3.5],
        deductions: [["I don't think it's wasting time", "The natural phrase is 'a waste of time'.", "I don't think it's a waste of time", "vocab"]],
        zh: "回答有清楚的立場、具體的價格比較，還預先回應了「浪費時間」的反駁，結構很完整。語言上幾乎沒有大錯，只有 wasting time 可以改成 a waste of time。要再往上，可以讓語調更有起伏，不要每個字都一樣重。",
        rewrite: "I usually choose the cheaper option. As a student, saving money matters more to me than saving an hour. When I go home to Taichung, for example, the high-speed rail costs about three times as much as the bus, so I always take the bus, even though the trip is four hours. I don't see it as a waste of time, either: I can sleep, or review my notes for the week.",
      },
      "int-4": {
        text: "I would choose cheaper. Many commuters, like students and older people, take the bus every day, so the fare adds up. If the bus is faster, people save maybe five or ten minutes, but if it's cheaper, some people can, um, can afford to take it at all. So I think cheaper helps more people.",
        final: 3.5,
        judges: { gemini: 3.5, openai: 3 },
        dims: [4, 3, 3.5, 3.5],
        deductions: [
          ["I would choose cheaper", "'Cheaper' on its own doesn't name the choice.", "I would choose making routes cheaper", "grammar"],
          ["can, um, can afford to take it at all", "A restart in the sentence that carries the argument.", "can afford to take it at all", "pronunciation-proxy"],
        ],
        zh: "這次有把理由講出來：快只是省五到十分鐘，便宜卻決定有些人搭不搭得起，這個比較很有說服力。只是開頭 I would choose cheaper 太簡短，建議說完整：I'd choose making the routes cheaper。",
        rewrite: "I'd choose making routes cheaper. Many commuters, especially students and older people, ride the bus every day, so the fare adds up over a month. A faster route might save someone five or ten minutes, but a cheaper one decides whether some people can afford to ride at all. That's why I think lower fares would help more commuters.",
      },
    },
  },
} satisfies Record<string, SpeakingContent>;
