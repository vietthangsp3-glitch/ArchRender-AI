import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Toggle } from "./ui";

describe("Toggle", () => {
  it("exposes switch state and emits the next value", () => {
    const onChange = vi.fn();
    render(<Toggle checked={false} onChange={onChange} label="Tiled upscale" />);
    const control = screen.getByRole("switch", { name: "Tiled upscale" });
    expect(control).toHaveAttribute("aria-checked", "false");
    fireEvent.click(control);
    expect(onChange).toHaveBeenCalledWith(true);
  });
});
