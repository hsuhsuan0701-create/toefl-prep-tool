import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import ModulePathDisclosure from "../src/components/ModulePathDisclosure";

describe("ModulePathDisclosure", () => {
  it("renders nothing when modulePath is null or undefined", () => {
    const { container: nullContainer } = render(<ModulePathDisclosure modulePath={null} />);
    expect(nullContainer).toBeEmptyDOMElement();

    const { container: undefinedContainer } = render(<ModulePathDisclosure modulePath={undefined} />);
    expect(undefinedContainer).toBeEmptyDOMElement();
  });

  it("discloses the Upper Module path with no cap sentence", () => {
    render(<ModulePathDisclosure modulePath="upper" />);
    const text = screen.getByTestId("module-path-disclosure").textContent ?? "";
    expect(text).toMatch(/Upper Module/);
    expect(text).not.toMatch(/capped/);
    expect(text).not.toMatch(/4\.5/);
  });

  it("discloses the Lower Module path AND the 4.5 cap, framed as our own assumption not ETS policy", () => {
    render(<ModulePathDisclosure modulePath="lower" />);
    const text = screen.getByTestId("module-path-disclosure").textContent ?? "";
    expect(text).toMatch(/Lower Module/);
    expect(text).toMatch(/capped at 4\.5/);
    expect(text).toMatch(/not published ETS policy/);
  });
});
