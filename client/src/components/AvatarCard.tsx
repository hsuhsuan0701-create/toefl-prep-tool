import { AudioStage, SpeakerFigure } from "../ui/AudioStage";

export type AvatarCardSpeaker = {
  role: string;
  gender: "male" | "female";
  accent: string;
};

export type AvatarCardProps = {
  speakers: AvatarCardSpeaker[];
  setting?: string;
};

// Who is speaking in a Listening Stimulus, and where: ui/AudioStage's stage and figures, inline SVG,
// no image and no network. A speaker is the served Speaker's role, gender and accent (stripAnswers
// has already dropped the TTS `voice` and `provider`). `setting` is the backdrop line: a
// Conversation's or Announcement's `setting`, an Academic Talk's `discipline`, nothing for Listen
// and Choose a Response (settingOf in StimulusQuestions.tsx).
//
// There is no prop for Item content (no utterance, transcript or Explanation), so this card cannot
// leak the Listen and Choose a Response utterance, which is never shown as text, even to a caller
// that holds the whole Item.
//
// `gender` picks the silhouette and is never printed; role, accent (in words: "North American") and
// setting are the only text. `speakers` holds one speaker, or two for a Conversation; an empty array
// renders nothing, so a caller still loading can pass `[]`.
export default function AvatarCard({ speakers, setting }: AvatarCardProps) {
  if (speakers.length === 0) return null;

  return (
    <AudioStage data-testid="avatar-card" setting={setting}>
      {speakers.map((speaker, index) => (
        <SpeakerFigure
          key={`${speaker.role}-${index}`}
          data-testid="avatar-figure"
          role={speaker.role}
          accent={speaker.accent}
          gender={speaker.gender}
        />
      ))}
    </AudioStage>
  );
}
