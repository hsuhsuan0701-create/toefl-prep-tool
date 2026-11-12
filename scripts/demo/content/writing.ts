/**
 * The demo User's emails and discussion posts, and the Score Reports they earned, keyed by the
 * Writing Set they answer. Written for this demo in the voice of an upper-intermediate learner whose
 * first language is Mandarin: recurring article, agreement and tense slips, comma splices, and
 * content that gets more specific over the three weeks. Nothing here comes from ETS or from anyone's
 * real practice.
 *
 * Every Deduction quote is copied verbatim from the Response above it (reports.ts refuses one that
 * is not), and every `dims` row is the Arbiter's per-dimension reading in DIMENSIONS order
 * (reports.ts). "Day 19" on an entry means 19 days before `today`, as in seed.ts's history.
 */
import type { JudgedResponse } from "../reports.js";

/** A Response whose scoring failed: it is stored, and nothing scored it. */
export type FailedEssay = { text: string; failed: "both judges failed" };
export type EssayOutcome = JudgedResponse | FailedEssay;
export type WritingContent = { email: EssayOutcome; discussion?: EssayOutcome };

export const WRITING: Record<string, WritingContent> = {
  // Day 19, first Writing Drill.
  "wri-77af733e": {
    email: {
      text: `Dear Bike-Share Program Office,

I am a student who use the bike-share program almost every morning. It is very useful for me because my first class start at 8 AM and the building is far from my dorm, so riding a bike save me about fifteen minutes.

However, last Tuesday I had a problem. I reserved a bike on the app at night, but when I arrived the station in the morning, the bike was not there. I waited for some minutes and then I have to walk to the class, so I was late.

I suggest that the app can check if the bike is really at the station before it accept a reservation. Thank you for reading my feedback.

Best regards,
Wei-Ting Chen`,
      final: 3,
      dims: [3, 2.5, 2.5, 4],
      notes: [
        "All three bullets are answered and the tone is polite, but the problem and the suggestion get one sentence each, so the office has little to act on.",
        "Each paragraph handles one bullet, which keeps it clear; the problem paragraph needs one more detail, such as which station or what the app showed.",
        "Frequent agreement and tense slips ('who use', 'my first class start', 'I have to walk') are noticeable, though the meaning stays clear.",
        "Spelling and punctuation are clean, and the program name is capitalized consistently.",
      ],
      deductions: [
        ["a student who use the bike-share program", "Subject-verb agreement: 'who' refers to 'a student', so the verb takes -s.", "a student who uses the bike-share program", "grammar"],
        ["when I arrived the station", "'Arrive' needs 'at' before a place.", "when I arrived at the station", "grammar"],
        ["I waited for some minutes and then I have to walk", "The story is in the past, but 'have to' is present.", "I waited a few minutes and then had to walk", "grammar"],
        ["check if the bike is really at the station before it accept a reservation", "The suggestion is reasonable but general; it doesn't say how the office would act on it.", "confirm that a bike is actually docked before accepting a reservation, and send an alert if it is moved overnight", "elaboration"],
      ],
      zh: "三個要點都有回應，語氣也得體，但每一點都只寫了一兩句，主辦單位看完不太知道該怎麼處理。主詞動詞一致（who uses、class starts）和時態（had to walk）是這篇最常扣分的地方，寫完後專門檢查一次動詞。",
      rewrite: `Dear Bike-Share Program Office,

I'm a first-year student who reserves a bike almost every morning, and the program has made a real difference for me. My first class starts at 8 a.m. in the engineering building, a twenty-minute walk from my dorm, so riding cuts my commute in half.

Last Tuesday, however, my reservation failed. I booked a bike through the app the night before, and the app still showed it as reserved when I reached the North Gate station at 7:40, but the dock was empty. After waiting ten minutes, I had to walk across campus and arrived late to my lab section.

Could the app confirm that a bike is actually docked before it accepts a reservation, and send a notice if the bike is moved overnight? That would give students time to make other plans.

Thank you for asking for feedback.

Best regards,
Wei-Ting Chen`,
    },
    discussion: {
      text: `In my opinion, I think cities should convert some street parking into public space. Like Priya said, wider sidewalk make the street more nice and people will stay longer, it is good for the cafés and shops. In my hometown Taichung, there is a street that become a walking street on weekends and many people go there. But I also understand Marcus, some old people need parking. So the city can keep a few parking for disabled people. Overall, public space is more better for the city.`,
      final: 2.5,
      own: 2.5,
      judges: { gemini: 2.5, openai: 3 },
      dims: [3, 2.5, 2, 3],
      notes: [
        "Takes a clear side and nods to both classmates, but mostly repeats Priya's point instead of adding a reason of its own.",
        "The Taichung street is a promising example that is left undeveloped, and the post moves between ideas without linking them.",
        "Short sentences with frequent errors in plurals and comparatives ('more nice', 'more better') and a comma splice.",
        "Mostly correct; one run-on sentence.",
      ],
      deductions: [
        ["In my opinion, I think", "Two openers that say the same thing.", "I think", "register"],
        ["wider sidewalk make the street more nice", "Plural and comparative errors.", "wider sidewalks make the street nicer", "grammar"],
        ["people will stay longer, it is good for the cafés", "Comma splice: two full sentences joined by a comma.", "people will stay longer, which is good for the cafés", "grammar"],
        ["there is a street that become a walking street on weekends and many people go there", "The Taichung example is the strongest part, but it stops at 'many people go there' without saying what changed.", "there is a street that becomes pedestrian-only on weekends, and the shops along it now do most of their business on those two days", "elaboration"],
        ["more better", "Double comparative.", "better", "grammar"],
      ],
      zh: "立場清楚，也有提到兩位同學的觀點，但大多是在重複 Priya 的理由，沒有加入自己的新論點。台中步行街的例子很好，可惜只寫了一句就結束，應該說明改成步行街之後商家或居民有什麼具體變化。比較級（nicer、better）和用逗號連接兩個句子的問題要特別注意。",
      rewrite: `I think cities should convert at least some downtown parking into public space, but street by street rather than all at once. Priya's experience matches what I saw in my hometown, Taichung: one shopping street became pedestrian-only on weekends, and within a year the small shops there were doing most of their business on Saturdays and Sundays. At the same time, Marcus is right that some people cannot simply switch to the bus. A practical answer is to keep a few accessible spaces and a drop-off zone on each converted block. That way the city gains space people actually use without cutting off residents who depend on driving.`,
    },
  },

  // Day 15, first Writing Simulation.
  "wri-90026a0d": {
    email: {
      text: `Hello,

Thank you for confirming my spot in the new evening stretching class so fast. I am really looking forward to it.

But I found a problem in the confirmation email. It says the class will be in Room 204, but I think this is wrong. When I visited the clinic last week, the receptionist told me the stretching classes are always in the studio on the first floor, and Room 204 is a doctor's office.

The class begins in two days, so could you please tell me the correct room before Thursday? I don't want to go to the wrong place and miss the beginning.

Thank you,
Wei-Ting Chen`,
      final: 3.5,
      dims: [3.5, 4, 3, 4.5],
      notes: [
        "All three bullets are covered in order, and the reason the room must be wrong is convincing; a few phrases are more casual than the situation calls for.",
        "The second paragraph gives a concrete reason (what the receptionist said), exactly the kind of detail this task rewards.",
        "Mostly accurate, but the sentences rarely go beyond 'but' and 'so'.",
        "No spelling or punctuation errors.",
      ],
      deductions: [
        ["so fast", "A little casual for a clinic's scheduling coordinator.", "so quickly", "register"],
        ["But I found a problem in the confirmation email.", "Opening a paragraph with 'But' sounds abrupt in a formal email.", "However, I noticed an error in the confirmation email.", "register"],
        ["but I think this is wrong", "'I think' weakens a point you can support; you know the room is wrong.", "which appears to be a mistake", "register"],
      ],
      zh: "三個要點都有完成，而且用櫃台人員說過的話來說明為什麼教室有誤，這個細節很有說服力。扣分主要在語氣：so fast、段首的 But、I think this is wrong 對診所的協調人員來說都太口語或太不確定，可以改用 so quickly、However、appears to be a mistake。",
      rewrite: `Dear Scheduling Coordinator,

Thank you for confirming my place in the new evening stretching class so quickly; I'm looking forward to the first session.

However, the confirmation email lists the class in Room 204, which appears to be a mistake. When I visited the clinic last week, the receptionist mentioned that group classes are held in the first-floor studio, and Room 204 is one of the examination rooms.

Since the class begins this Thursday, could you let me know the correct room before then? I'd like to arrive on time and not interrupt the warm-up.

Thank you for your help,
Wei-Ting Chen`,
    },
    discussion: {
      text: `I agree with Marcus that programs should mix both kinds of trees. Native trees are good for birds and insects, but waiting ten years for shade is too long for people who live there now. In summer my city is very hot, sometimes over 36 degrees, and the streets without trees are almost impossible to walk. If the program plant fast-growing trees together with native trees, residents can get shade soon, and later the native trees will become big and support the local animals. So I think mixing is the most balance way.`,
      final: 3,
      dims: [3, 3.5, 2.5, 4],
      notes: [
        "A clear position that builds on Marcus; Priya's point is mentioned but not answered.",
        "The heat example (over 36 degrees) is specific and relevant, and the plan at the end follows from it.",
        "A few agreement and word-form errors; the vocabulary is adequate but repetitive.",
        "Clean.",
      ],
      deductions: [
        ["Native trees are good for birds and insects", "Repeats Priya's point without answering it; say why it doesn't outweigh the shade problem.", "Native trees do support more wildlife, as Priya says, but that benefit arrives decades later, while the heat problem is here now", "elaboration"],
        ["almost impossible to walk", "'Walk' needs 'along' or 'on' here.", "almost impossible to walk along", "grammar"],
        ["If the program plant fast-growing trees", "Subject-verb agreement.", "If the program plants fast-growing trees", "grammar"],
        ["the most balance way", "Word form: the adjective is 'balanced'.", "the most balanced approach", "vocab"],
      ],
      zh: "立場明確，也用了 36 度高溫的具體例子支持論點，這點做得很好。不過只是提到 Priya 的觀點，沒有真正回應她，學術討論的題目會看你有沒有和其他人的論點對話。另外注意 plants 的主詞動詞一致，以及 balanced 的詞性。",
      rewrite: `I agree with Marcus that a mixed approach is fairer, although Priya is right that native trees do more for local wildlife. The problem is timing: in my city, summer afternoons regularly pass 36 degrees, and streets without mature trees are almost impossible to walk along. Asking residents to wait ten years for shade puts the cost of the program on the people who need relief now. A better plan would be to plant fast-growing trees and native species side by side, then remove the fast-growing ones once the native trees are large enough to shade the street. Residents would get shade within a few years, and the program would still end up with the long-term ecological value Priya wants to protect.`,
    },
  },

  // Day 9, Writing Simulation. The discussion post is the Item the Judges disagreed on.
  "wri-7024b060": {
    email: {
      text: `Dear Visitor Programs Team,

I visited Willowbrook Art Garden last Saturday and took the self-guided outdoor tour. I enjoyed the sculptures, but I want to tell you about a problem with the printed map.

The numbers on the map did not match the signs at the stops. For example, the map said stop 3 was a bronze horse, but the sign with number 3 was in front of a glass sculpture. The horse was actually at the sign number 5.

Me and other visitors were confused from the third stop. Some people started walking backward to check the earlier stops, and a family behind me gave up and just walked around without the map.

Could you please print a corrected map before the next tour on Saturday? I think it will help a lot of visitors.

Best regards,
Wei-Ting Chen`,
      final: 3.5,
      judges: { gemini: 3.5, openai: 3 },
      dims: [4, 3.5, 3, 4.5],
      notes: [
        "All three bullets are handled, and the bronze-horse example makes the mismatch concrete. The request is clear.",
        "Specific detail in the second and third paragraphs; the closing is generic.",
        "Generally accurate; 'Me and other visitors' and 'the sign number 5' are noticeable slips.",
        "No errors.",
      ],
      deductions: [
        ["Me and other visitors were confused", "Subject pronoun needed, and the speaker goes last.", "Other visitors and I were confused", "grammar"],
        ["at the sign number 5", "Unnatural phrasing for a numbered sign.", "at the stop marked 5", "vocab"],
        ["I think it will help a lot of visitors.", "Ends on a vague benefit; a closing that asks for something specific is stronger.", "I would also appreciate a short reply once it is ready.", "elaboration"],
      ],
      zh: "這封信的具體例子（地圖上的 3 號是銅馬，實際卻是玻璃雕塑）讓問題一看就懂，第三段描述其他遊客的反應也很生動。扣分在 Me and other visitors 這種主格錯誤，以及結尾太空泛。結尾可以直接請對方在修正後回信通知你。",
      rewrite: `Dear Visitor Programs Team,

I took the self-guided sculpture tour at Willowbrook Art Garden last Saturday and wanted to let you know about a problem with the printed stop map.

The numbers on the map did not match the signs posted at the stops. The map listed stop 3 as the bronze horse, for example, but the sign marked 3 stood in front of a glass sculpture, and the horse was actually at the stop marked 5.

By the third stop, other visitors and I could no longer tell which description went with which artwork. A few people walked back to check earlier stops, and one family gave up on the map entirely.

Could you print a corrected map before next Saturday's scheduled tour? I would also appreciate a short reply once it is ready, since I plan to bring friends.

Best regards,
Wei-Ting Chen`,
    },
    discussion: {
      text: `I think new users should start with an empty library. Tomas made a good point that the first songs become the data for the algorithm. When I started using a music app last year, it give me a lot of K-pop because I clicked one song in the first day, and after that it was very hard to change. I had to skip many songs every day. If I build my library myself, the app learn what I really like. Maya said blank library is extra work, but I think it is only a few minutes, and the platform can show some popular songs as suggestions without putting them in your library.`,
      final: 3,
      own: 3,
      judges: { gemini: 2.5, openai: 4 },
      dims: [4, 3.5, 2.5, 4],
      notes: [
        "Takes a clear side, builds on Tomas and answers Maya with a compromise; this is the strongest part of the post.",
        "The K-pop example supports the claim directly; the reply to Maya is brief.",
        "Repeated verb-form errors ('it give', 'the app learn') and missing articles; vocabulary is everyday.",
        "Clean.",
      ],
      deductions: [
        ["it give me a lot of K-pop", "Past tense needed in a past story.", "it gave me a lot of K-pop", "grammar"],
        ["in the first day", "Days take 'on'.", "on the first day", "grammar"],
        ["the app learn what I really like", "Third-person -s dropped.", "the app learns what I really like", "grammar"],
        ["Maya said blank library is extra work", "Missing article.", "Maya said a blank library is extra work", "grammar"],
      ],
      reconciliation:
        "The Judges split by 1.5 points: one read the verb errors as limiting (2.5), the other weighted the engagement with both classmates (4). The Arbiter's own reading was 3: the argument reaches band 4, but errors in almost every other sentence hold the language at band 3, and the rubric places a response by its whole profile.",
      zh: "這篇的論點其實不錯：你接續 Tomas 的看法，用自己被推薦 K-pop 的經驗當例子，也回應了 Maya 的反對意見。但幾乎每兩句就有一個動詞錯誤（it gave、the app learns），這讓兩位評分者的分數差了 1.5 分，所以這題的分數比較不確定。先把動詞時態和第三人稱單數修好，這篇就有機會到 4。",
      rewrite: `I think new users should start with an empty library, mainly for the reason Tomas gives: the first few songs become the data the algorithm relies on. When I started using a music app last year, I played one K-pop song on the first day, and for weeks afterward the app filled my recommendations with K-pop. I spent more time skipping songs than listening to them. If I had built my library myself, the app would have learned what I actually enjoy. Maya worries that a blank library feels like extra work, but the platform could still show a few popular tracks as suggestions without adding them to the library, which keeps the start easy while leaving the early choices to the listener.`,
    },
  },

  // Day 6, the Writing section of the completed Full-Test Run. The email was Self-Arbitrated.
  "wri-f9779355": {
    email: {
      text: `Dear Bluewater Kayak Tours,

I booked a guided kayak tour on your website for this Saturday. However, the payment confirmation email I just received says the tour is on next Wednesday. I am sure I chose Saturday, because I am not free on weekdays.

Could you please send me a written confirmation with the correct date before I arrive? I know your phone line is not staffed until the day of the tour, so email is the only way I can check.

If the date cannot be corrected in time, I would like to ask whether it is possible to get a refund.

Thank you for your help.

Sincerely,
Wei-Ting Chen`,
      final: 3.5,
      dims: [4, 3, 3.5, 4.5],
      selfArbitrated: true,
      notes: [
        "All three bullets are covered politely and in a sensible order; the refund question is appropriately tentative.",
        "Clear and well organized, but it leaves out the booking details the outfitter would need to find the reservation.",
        "Accurate, mostly simple sentences; one preposition error.",
        "No errors.",
      ],
      deductions: [
        ["says the tour is on next Wednesday", "'On' is not used before 'next'.", "says the tour is next Wednesday", "grammar"],
        ["I am sure I chose Saturday, because I am not free on weekdays.", "Explains why you're sure but gives no booking reference to find the reservation by.", "I'm certain I selected Saturday (booking reference BK-2291), since I work on weekdays.", "elaboration"],
      ],
      zh: "語氣有禮貌、三個要點順序合理，退款的問法也很得體。主要缺少的是具體資訊：訂單編號、訂的是哪個時段，對方才能馬上找到你的預約。on next Wednesday 的 on 要拿掉。",
      rewrite: `Dear Bluewater Kayak Tours,

I booked a guided kayak tour on your website for this coming Saturday at 9 a.m. (booking reference BK-2291). However, the payment confirmation I just received lists the tour as next Wednesday. I'm certain I selected Saturday, since I work on weekdays and couldn't attend midweek.

Because your phone line won't be staffed until the day of the tour, could you reply to this email with written confirmation of the Saturday date before I arrive?

If the booking cannot be moved back to Saturday in time, could you let me know whether a refund would be possible?

Thank you for your help.

Sincerely,
Wei-Ting Chen`,
    },
    discussion: {
      text: `I agree with Mara that community theaters should cap the price increase. Community theater is different from big commercial theater, the main audience is local families and students who have limited budget. If the price follow the demand, the popular shows will become only for rich people, and this is not the purpose of community theater. Theo is right that theaters need money for better sets, but they can get this money from other ways, for example donation or selling snacks during the break. In my opinion, keeping the audience is more important than having a bigger set.`,
      final: 3.5,
      judges: { gemini: 3, openai: 3.5 },
      dims: [4, 3, 3, 3.5],
      notes: [
        "Sides with Mara and answers Theo directly, which is what this task asks for.",
        "The reply to Theo lists two funding ideas without showing they would cover the cost, so the argument thins out at its key point.",
        "Two comma splices and several agreement slips, though the vocabulary is well chosen for the topic.",
        "Mostly clean apart from the comma splices.",
      ],
      deductions: [
        ["Community theater is different from big commercial theater, the main audience", "Comma splice.", "Community theater is different from big commercial theater: its main audience", "grammar"],
        ["who have limited budget", "Plural needed.", "who have limited budgets", "grammar"],
        ["If the price follow the demand", "Agreement, and no articles before general nouns.", "If prices follow demand", "grammar"],
        ["for example donation or selling snacks during the break", "Alternative funding is a good reply to Theo, but two examples in a list don't show it would cover the cost.", "for example, a donor program that funds set upgrades, which many community theaters already run", "elaboration"],
      ],
      zh: "你接了 Mara 的立場，也直接回應 Theo 的論點，結構是對的。可惜回應 Theo 的部分只列了「捐款、賣零食」兩個點，沒有說明這些錢夠不夠支付佈景，論證就弱了。用逗號連接兩個完整句子在這篇出現兩次，要改成句號或加連接詞。",
      rewrite: `I agree with Mara that community theaters should cap their price increases. A community theater is not a commercial venue: its audience is mostly local families and students on limited budgets, and its purpose is to keep live performance within their reach. If prices simply followed demand, the most popular shows would be the first ones those families could no longer afford. Theo is right that theaters need money for bigger sets and guest directors, but demand pricing is not the only way to raise it. Many community theaters run donor programs or sponsor nights that fund specific productions, which lets people who can pay more choose to do so. Keeping the regular audience matters more in the long run than one season's larger set.`,
    },
  },

  // Day 4, Writing Simulation whose discussion post failed scoring: the Attempt has no band.
  "wri-736f2103": {
    email: {
      text: `Dear Collections Manager,

Thank you for the cataloging orientation last Saturday. I learned a lot about how to handle the donated letters, especially the part about recording the condition of each item before it goes on the shelf.

While I was shelving items after the session, I noticed a diary from the 1920s that seems to be part of the recent donation. It has a brown leather cover and some loose pages near the back, and it was sitting on the shelf without an acid-free sleeve.

Since the pages are already fragile, could a protective sleeve be added before anyone handles the diary again? I would be glad to help with it at my next shift if that is useful.

Best regards,
Wei-Ting Chen`,
      final: 4,
      dims: [4.5, 4, 3.5, 5],
      notes: [
        "Every bullet is handled with the right politeness for a volunteer writing to staff, and the offer to help is a good touch.",
        "Specific and well connected; the one gap is where exactly the diary is.",
        "Accurate, with some variety ('while' and 'since' clauses); a few plain word choices.",
        "No errors.",
      ],
      deductions: [
        ["it was sitting on the shelf without an acid-free sleeve", "Doesn't say where the diary is, which the manager needs to find it.", "it was on the second shelf of the new-donations cart, without an acid-free sleeve", "elaboration"],
        ["if that is useful", "Slightly unnatural for an offer of help.", "if that would help", "vocab"],
      ],
      zh: "這封信完成度很高：感謝的部分有提到具體學到的內容，描述日記時也有外觀細節，最後還主動提出可以幫忙，語氣非常適合志工寫給館員。要拿 5 分，可以補上日記放在哪個位置，讓對方能馬上找到；if that is useful 改成 if that would help 會更自然。",
      rewrite: `Dear Collections Manager,

Thank you for Saturday's cataloging orientation. The part on recording each letter's condition before it is shelved was especially useful, and I used it for the first time that same afternoon.

While shelving items after the session, I noticed a diary from the 1920s that appears to belong to the recent donation. It has a brown leather cover and several loose pages near the back, and it was on the second shelf of the new-donations cart without an acid-free sleeve.

Since the pages already seem fragile, could a protective sleeve be added before anyone handles the diary again? I'd be glad to help with this during my next shift if that would help.

Best regards,
Wei-Ting Chen`,
    },
    discussion: {
      text: `I think reservation slots are a good idea only for the busiest machines. Maya's problem is real, I also waited for the squat rack many times after my classes. But Dmitri is right that a full reservation system would make the gym less flexible. A better solution is to let members reserve only the few machines that always have a line, like squat racks, and keep everything else first-come, first-served. Also the slots should be short, for example 30 minutes, so people who drop in can still use the machine between the reservations. This way both kind of members can be satisfied.`,
      failed: "both judges failed",
    },
  },

  // Day 2, Writing Drill: Build a Sentence and the email only. One Judge returned a report.
  "wri-be127d2e": {
    email: {
      text: `Hi Jordan,

I'm really sorry, but I have to tell you that one of the support poles of your tent broke during our trip. It's completely my fault for not checking the weather more carefully, and I'll take care of it.

On Saturday night the wind got really strong around midnight. One gust pushed the side of the tent down and the middle pole snapped in two. Luckily nobody was hurt and the tent fabric is fine.

I already found the same pole on the brand's website, and I can order it this week so it arrives well before you need the tent next month. If you prefer, I can also bring the tent to the outdoor shop downtown and have them replace it. Just let me know which is easier for you.

Sorry again,
Wei-Ting`,
      final: 4.5,
      judges: { gemini: 4.5, openai: null },
      dims: [5, 4.5, 4, 5],
      notes: [
        "A sincere apology that takes responsibility, explains what happened and offers two ways to fix it: the purpose of the email is fully met.",
        "Well developed; the middle paragraph gives exactly the detail a friend would want.",
        "Natural and mostly accurate; a tense slip and one wordy possessive.",
        "No errors.",
      ],
      deductions: [
        ["one of the support poles of your tent broke", "Wordy possessive.", "one of your tent's support poles broke", "vocab"],
        ["I already found the same pole", "Present perfect fits an action that matters now.", "I've already found the same pole", "grammar"],
      ],
      zh: "道歉真誠、有承擔責任，也說清楚桿子是怎麼斷的，最後還提出兩個解決方案讓朋友選，這封信的溝通目的完成得很好。小地方：I already found 用現在完成式 I've already found 更自然，one of the support poles of your tent 可以簡化成 one of your tent's support poles。",
      rewrite: `Hi Jordan,

I'm really sorry, but one of your tent's support poles broke during our trip. It's completely my fault for not checking the forecast more carefully, and I'll take care of it.

On Saturday night the wind picked up around midnight, and one strong gust pushed the side of the tent in until the middle pole snapped in two. Luckily nobody was hurt, and the fabric is fine.

I've already found the same pole on the brand's website, and if I order it this week it will arrive well before you need the tent next month. If you'd rather, I can take the tent to the outdoor shop downtown and have them replace the pole instead. Just let me know which is easier for you.

Sorry again,
Wei-Ting`,
    },
  },
};
