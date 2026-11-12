# Release checklist

What the automated suites cannot see: a real browser, a real microphone, real speakers, real
providers, and a real server restart. Both suites are hermetic: no microphone, no audio output, no
model call, no second process. Everything they do cover is left out of this list, including
recorder state, retry gates, the Listening leak gate, leave guards, timers and Build a Sentence
commits.

Run it before a release, and run the matching section after any change to recording, playback,
drag-and-drop, timing, scoring prompts or generation. Sections A–H take about half an hour. Section I
makes paid generation calls and runs last.

**Setup.**

- Chrome with DevTools open on the Network tab.
- A microphone and headphones.
- Both API keys in `.env`, and the Claude or Codex CLI logged in.
- Start from a data directory with no database: `TOEFL_DATA_DIR` pointing at a copy of `data/`
  without `db.sqlite`, or a fresh clone.
- Run `npm start`. Use `npm run dev` only where a step says so.

## A. First run (2 min)

- [ ] `npm ci && npm start` on a fresh clone comes up at <http://localhost:5173>. The Dashboard shows
      no Overall band, and each section says what to score before it has one.
- [ ] The Setup checklist matches what you configured. Blank one key in `.env`, restart, and it names
      that key and what it turns off. Restore the key.
- [ ] Log out of the Claude CLI in another terminal and press **Check again**: its row changes with
      no restart. Log back in and check again.

## B. Microphone and playback (5 min, Speaking Drill on any Set)

- [ ] **Mic check, allowed.** The browser asks, a short test recording runs with a level meter that
      moves with your voice, and playback is your own voice at a normal volume.
- [ ] **Mic check, denied.** Deny the prompt: a readable error says how to fix it. After you allow
      the microphone in the browser's site settings, trying again works.
- [ ] **Ready screen.** Nothing plays, the operating system's mic indicator is off, and no
      `POST /api/attempts` appears until you begin. Double-clicking Begin creates one Attempt.
- [ ] **Briefing.** The Listen and Repeat briefing plays once, with no beep and no recording, and the
      scene shows with no highlight ring. Item 1 then starts on its own, once.
- [ ] **Prompt, beep, record.** Each prompt plays exactly once. The beep is clearly audible and
      distinct from the prompt, and recording visibly starts right after it. Speak the moment the beep
      ends on a few Items; on playback the first word is not cut off.
- [ ] **Scene ring.** The ring moves to the object each sentence names. With the operating system's
      reduce-motion setting on, it changes place without animating.
- [ ] **Interview.** No scene appears during the Interview intro or its questions.

## C. Speaking scoring with real providers (4 min)

- [ ] After the last Listen and Repeat Item, scoring progress moves only at real checkpoints (Judges,
      then Arbiter, then saved). It shows no invented percentage.
- [ ] Results show each target sentence with a word-level diff, your recording replays, and the Score
      Card has both Judges' detail and Deductions quoting what you said.
- [ ] Network tab: exactly one `POST /api/attempts/:id/score` per Task Type. Repeat once under
      `npm run dev`, where React StrictMode runs effects twice; a duplicate here is a duplicate paid
      call.
- [ ] Stay silent for one Item. It scores 0 marked as no speech, and its siblings score normally.

## D. Writing (5 min, Writing Drill)

- [ ] **Build a Sentence, mouse.** Drag a tile onto a chosen blank, from one blank onto another (they
      swap), and back to the tray. Tapping a tile does nothing.
- [ ] **Build a Sentence, keyboard.** Tab to a tile and pick it up, move it and drop it with the
      keyboard.
- [ ] **Build a Sentence, touch.** On a phone or tablet (or DevTools touch emulation), a dragged tile
      follows your finger and the page does not scroll. A drag that starts off a tile still scrolls.
- [ ] **Essay.** The word count updates as you type, and submitting early submits at once. Once
      scored, the Score Card quotes your text in its Deductions, shows a Model Rewrite, and renders
      the summary in Traditional Chinese glyphs, not a Simplified or Japanese fallback.

## E. Reading and Listening (5 min)

- [ ] **Reading Drill.** Typing into a Complete the Words gap fills its letter boxes. A submitted
      question shows the key and its Explanation.
- [ ] **Listening Drill.** The Stimulus plays once with no player controls. Its options appear only
      when the audio ends.
- [ ] **Listening Simulation, audio failure.** Start one and set the Network tab to Offline as the
      first Stimulus loads, then back online. The Stimulus retries or waits on a prompt; it is never
      skipped and scored wrong.
- [ ] **Reading Simulation.** Submit the Router Module early. The Module Path is revealed, the second
      module starts on its own clock, and the report discloses the Module Path beside the band, or
      says what is still missing.

## F. Durability (6 min)

- [ ] **Closed tab.** Submit an essay for scoring and close the tab. Reopen the Attempt from the
      Dashboard: the page picks up the job's progress and the score lands.
- [ ] **Killed server.** Stop the server with `kill -9` while a scoring job runs, then start it again.
      The Attempt shows the Items as interrupted with a working Re-score. The restart itself makes no
      model call: check the server log.
- [ ] **Lost network during transcription.** Turn the machine's network off as you finish one
      Speaking Item, wait ten seconds, and turn it back on. Without re-recording, that Item is
      transcribed and scored within a few minutes, and the other Items keep their scores.
- [ ] **Second server.** Run `npm start` in a second terminal while the first is running. The second
      reports that the port or the database is in use and does not disturb the first.

## G. Logs (1 min)

- [ ] Over everything above, the server's terminal output contains no Response text, transcript,
      target sentence, prompt or API key.

## H. Layout (2 min)

- [ ] At 390 px wide, the Dashboard, a Drill and an Attempt review have no horizontal scroll and
      nothing overlaps. At 1440 px the columns use the space.

## I. Generation (paid; 10–30 min of waiting)

- [ ] **Writing Set.** Generate one. Its stages advance (plan, write, check, save), it appears on
      `/sets` without a reload, and it opens as a Drill.
- [ ] **Speaking Set.** Generate one. The audio stage counts its clips, the Set has a scene image,
      its audio plays, and any advisory notes show before you practise it.
- [ ] **Batch and cancel.** Ask for two Sets. A cost summary with call counts appears before anything
      starts. Cancel partway: finished Sets are kept, and `data/question-sets/`, `data/audio/stimuli/`
      and `data/images/scenarios/` hold nothing half-written.
- [ ] **No CLI.** Log out of both CLIs (or point `CLAUDE_BIN` and `CODEX_BIN` at nothing) and
      generate. The job fails promptly with a message naming both providers.

## Before a release that changes a Simulation

Sit that section's Simulation end to end, or a whole Full-Test Run when the Run itself changed. Check
that the clock feels like the real section, that nothing scores or reveals until the end, and that
the report matches what you answered.
