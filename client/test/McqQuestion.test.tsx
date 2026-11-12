import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import McqQuestion from "../src/components/McqQuestion";

const options = [
  { id: "a", text: "Option A" },
  { id: "b", text: "Option B" },
  { id: "c", text: "Option C" },
];

describe("McqQuestion", () => {
  it("renders 3-4 radio options", () => {
    render(<McqQuestion stem="Which one?" options={options} onSelect={vi.fn()} />);
    expect(screen.getAllByRole("radio")).toHaveLength(3);
    expect(screen.getByText("Option A")).toBeInTheDocument();
    expect(screen.getByText("Option B")).toBeInTheDocument();
    expect(screen.getByText("Option C")).toBeInTheDocument();
  });

  it("calls onSelect with the clicked option id", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<McqQuestion stem="Which one?" options={options} onSelect={onSelect} />);
    await user.click(screen.getByText("Option B"));
    expect(onSelect).toHaveBeenCalledWith("b");
  });

  it("result mode highlights the key vs the chosen option and shows 錯題解析", () => {
    render(
      <McqQuestion
        stem="Which one?"
        options={options}
        selected="a"
        result={{ correct: false, key: "b", explanationZh: "正確答案是 B，因為文中明確提到。" }}
        onSelect={vi.fn()}
      />,
    );

    const radios = screen.getAllByRole("radio") as HTMLInputElement[];
    expect(radios.every((r) => r.disabled)).toBe(true);

    expect(screen.getByText("Correct answer")).toBeInTheDocument();
    expect(screen.getByText("Your Response")).toBeInTheDocument();
    expect(screen.getByText("Incorrect")).toBeInTheDocument();
    expect(screen.getByText("正確答案是 B，因為文中明確提到。")).toBeInTheDocument();
  });

  it("result mode does not show a 'Your Response' badge when the chosen option was already correct", () => {
    render(
      <McqQuestion
        stem="Which one?"
        options={options}
        selected="b"
        result={{ correct: true, key: "b", explanationZh: "正確。" }}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByText("Correct answer")).toBeInTheDocument();
    expect(screen.queryByText("Your Response")).not.toBeInTheDocument();
    expect(screen.getByText("Correct")).toBeInTheDocument();
  });
});
