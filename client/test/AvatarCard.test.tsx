import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import AvatarCard from "../src/components/AvatarCard";

// AvatarCard draws who is speaking in a Listening Stimulus. Its props carry no Item content (no
// utterance, transcript or Explanation), only `{ speakers, setting? }`, each speaker a role, gender
// and accent. A Listen and Choose a Response utterance must never render as text, and this card
// cannot leak it because it never receives it.
describe("AvatarCard", () => {
  it("renders one figure per speaker with role text, for the one-speaker case (listen_choose/announcement/academic_talk)", () => {
    render(
      <AvatarCard
        speakers={[{ role: "professor", gender: "male", accent: "north-american" }]}
      />,
    );

    const card = screen.getByTestId("avatar-card");
    expect(card).toBeInTheDocument();

    const figures = screen.getAllByTestId("avatar-figure");
    expect(figures).toHaveLength(1);
    expect(figures[0].textContent).toMatch(/professor/i);
    // The served accent code, in words.
    expect(figures[0].textContent).toMatch(/North American/);
  });

  it("renders two figures for the conversation case (one male, one female)", () => {
    render(
      <AvatarCard
        speakers={[
          { role: "student", gender: "female", accent: "british" },
          { role: "librarian", gender: "male", accent: "australian" },
        ]}
        setting="campus dining hall"
      />,
    );

    const figures = screen.getAllByTestId("avatar-figure");
    expect(figures).toHaveLength(2);
    expect(figures[0].textContent).toMatch(/student/i);
    expect(figures[0].textContent).toMatch(/british/i);
    expect(figures[1].textContent).toMatch(/librarian/i);
    expect(figures[1].textContent).toMatch(/australian/i);
  });

  it("renders the setting line when provided, and omits it when not (listen_choose has no setting)", () => {
    const { rerender } = render(
      <AvatarCard
        speakers={[{ role: "narrator", gender: "female", accent: "north-american" }]}
        setting="a university bookstore"
      />,
    );
    expect(screen.getByTestId("avatar-card").textContent).toMatch(/a university bookstore/i);

    rerender(
      <AvatarCard speakers={[{ role: "narrator", gender: "female", accent: "north-american" }]} />,
    );
    expect(screen.getByTestId("avatar-card").textContent).not.toMatch(/university bookstore/);
  });

  it("never prints the literal words 'male' or 'female' as a caption — gender only selects the silhouette", () => {
    render(
      <AvatarCard
        speakers={[
          { role: "student", gender: "female", accent: "british" },
          { role: "professor", gender: "male", accent: "north-american" },
        ]}
      />,
    );
    const text = screen.getByTestId("avatar-card").textContent ?? "";
    expect(text).not.toMatch(/\bmale\b/i);
    expect(text).not.toMatch(/\bfemale\b/i);
  });

  it("renders nothing (no empty chrome box) for an empty speakers array", () => {
    const { container } = render(<AvatarCard speakers={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
