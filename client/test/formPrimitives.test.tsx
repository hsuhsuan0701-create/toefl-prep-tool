import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { BandSelect } from "../src/ui/BandSelect";
import { Dialog } from "../src/ui/Dialog";
import { InlineEdit } from "../src/ui/InlineEdit";

function TargetEdit({ value, onSave }: { value: number; onSave: (v: number) => Promise<void> }) {
  return (
    <InlineEdit
      label="Reading Target"
      value={value}
      display={<span>Target {value}</span>}
      field={(draft, setDraft) => <BandSelect label="Reading Target" hideLabel value={draft} onChange={setDraft} />}
      onSave={onSave}
    />
  );
}

describe("BandSelect", () => {
  it("offers the half-step 1–6 grid under its label and reports a number", async () => {
    const onChange = vi.fn();
    render(<BandSelect label="Reading Target" value={5.5} onChange={onChange} />);
    const select = screen.getByRole("combobox", { name: "Reading Target" });
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["1", "1.5", "2", "2.5", "3", "3.5", "4", "4.5", "5", "5.5", "6"]);
    await userEvent.selectOptions(select, "4.5");
    expect(onChange).toHaveBeenCalledWith(4.5);
  });
});

describe("InlineEdit", () => {
  it("saves nothing until Save, then closes and returns focus to Edit", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<TargetEdit value={5.5} onSave={onSave} />);

    await userEvent.click(screen.getByRole("button", { name: "Edit Reading Target" }));
    const select = screen.getByRole("combobox", { name: "Reading Target" });
    expect(select).toHaveFocus();
    await userEvent.selectOptions(select, "6");
    expect(onSave).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledWith(6);
    await waitFor(() => expect(screen.getByRole("button", { name: "Edit Reading Target" })).toHaveFocus());
  });

  it("Escape and Cancel leave the saved value alone", async () => {
    const onSave = vi.fn();
    render(<TargetEdit value={5.5} onSave={onSave} />);

    await userEvent.click(screen.getByRole("button", { name: "Edit Reading Target" }));
    await userEvent.selectOptions(screen.getByRole("combobox"), "3");
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.getByText("Target 5.5")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Edit Reading Target" }));
    expect(screen.getByRole("combobox")).toHaveValue("5.5");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onSave).not.toHaveBeenCalled();
  });

  it("keeps the editor open after a failed save, puts the field back to the saved value, and says why", async () => {
    const onSave = vi.fn().mockRejectedValue(new Error("the server is not running"));
    render(<TargetEdit value={5.5} onSave={onSave} />);

    await userEvent.click(screen.getByRole("button", { name: "Edit Reading Target" }));
    await userEvent.selectOptions(screen.getByRole("combobox"), "4");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't save the Reading Target: the server is not running");
    expect(screen.getByRole("combobox")).toHaveValue("5.5");
  });
});

describe("Dialog", () => {
  it("renders its title and body only while open, and Escape asks to close", () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <Dialog open={false} title="Generate Sets" actions={<button type="button">Generate</button>} onClose={onClose}>
        <p>Pick a mix.</p>
      </Dialog>,
    );
    expect(screen.queryByText("Pick a mix.")).toBeNull();

    rerender(
      <Dialog open title="Generate Sets" actions={<button type="button">Generate</button>} onClose={onClose}>
        <p>Pick a mix.</p>
      </Dialog>,
    );
    expect(screen.getByRole("dialog", { name: "Generate Sets" })).toBeInTheDocument();
    screen.getByRole("dialog").dispatchEvent(new Event("cancel", { cancelable: true }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
