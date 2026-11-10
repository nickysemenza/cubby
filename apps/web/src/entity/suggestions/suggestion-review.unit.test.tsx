import type { FieldSuggestion } from "@cubby/schemas/ai";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SuggestionReview, SuggestionVisitProvider } from "./suggestion-review";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const suggestion: FieldSuggestion = {
  value: "tools",
  label: "Tools",
  confidence: "high",
  probability: 0.97,
  detail: null,
  reasoning: "",
  alternatives: [],
  operation: "set",
  removals: [],
};

const removeSuggestion: FieldSuggestion = {
  value: "apparel, jacquemus",
  label: "Remove apparel, jacquemus",
  confidence: "high",
  probability: 0.9,
  detail: "restates classification, brandName",
  reasoning: "",
  alternatives: [],
  operation: "remove",
  removals: [
    { value: "jacquemus", probability: 0.95, reason: "restates brandName" },
    { value: "apparel", probability: 0.9, reason: "restates classification" },
  ],
};

describe("inline suggestion review", () => {
  it.each([false, true])(
    "keeps evidence collapsed until Review without hiding the actionable proposal (phone=%s)",
    async (phone) => {
      vi.stubGlobal("matchMedia", (media: string) => ({
        matches: phone,
        media,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }));
      const save = vi.fn();
      render(
        <SuggestionReview
          suggestion={{ ...suggestion, reasoning: "Evidence from the record" }}
          currentValue={null}
          questionKey="compact-review"
          onApply={save}
        />,
      );
      expect(screen.getByRole("button", { name: "Accept" })).toBeVisible();
      expect(screen.queryByText("Evidence from the record")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Review" }));
      await waitFor(() =>
        expect(screen.getByText("Evidence from the record")).toBeVisible(),
      );
      fireEvent.click(
        within(screen.getByRole("dialog")).getByRole("button", {
          name: "Accept",
        }),
      );
      expect(save).toHaveBeenCalledOnce();
    },
  );
  it("shows a remove proposal's own apply/secondary labels and muted reason", () => {
    const save = vi.fn().mockResolvedValue(undefined);
    render(
      <SuggestionReview
        suggestion={removeSuggestion}
        currentValue="apparel, jacquemus, mount"
        questionKey="tags"
        onApply={save}
      >
        <span>mount</span>
      </SuggestionReview>,
    );
    // The current chips (`children`) always render for a remove proposal —
    // there is no "replace with a new value" arrow flow.
    expect(screen.getByText("mount")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Remove apparel, jacquemus — restates classification, brandName",
      ),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    expect(save).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByText("Review", { exact: true }));
    expect(screen.getByRole("button", { name: "Reject" })).toBeInTheDocument();
  });

  it("shows both values, requires acceptance, and retains the proposal after a failed save", async () => {
    const errorSpy = vi.spyOn(toast, "error").mockImplementation(() => "");
    const save = vi
      .fn()
      .mockRejectedValueOnce(new Error("unavailable"))
      .mockResolvedValue(undefined);
    render(
      <SuggestionReview
        suggestion={suggestion}
        currentValue="materials"
        currentLabel="Materials"
        questionKey="one"
        onApply={save}
      />,
    );
    expect(screen.getByText("Materials")).toBeInTheDocument();
    expect(screen.getByText("Tools")).toBeInTheDocument();
    expect(save).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("unavailable");
    expect(screen.getByText("Materials")).toBeInTheDocument();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    await waitFor(() =>
      expect(screen.queryByText("Tools")).not.toBeInTheDocument(),
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("keeps the existing editor once in the comparison and available after dismissal", () => {
    const edit = vi.fn();
    render(
      <SuggestionReview
        suggestion={suggestion}
        currentValue="materials"
        questionKey="editor"
        onApply={() => {}}
      >
        <button type="button" onClick={edit}>
          Materials
        </button>
      </SuggestionReview>,
    );
    expect(screen.getAllByText("Materials")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Materials" }));
    expect(edit).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByText("Review", { exact: true }));
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    expect(screen.queryByText("Tools")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Materials" }));
    expect(edit).toHaveBeenCalledTimes(2);
  });

  it("records a Miss when Reject is chosen", async () => {
    const onDismiss = vi.fn(async () => {});
    render(
      <SuggestionReview
        suggestion={suggestion}
        currentValue="materials"
        questionKey="miss"
        onApply={() => {}}
        onDismiss={onDismiss}
      />,
    );
    fireEvent.click(screen.getByText("Review", { exact: true }));
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    await vi.waitFor(() => expect(onDismiss).toHaveBeenCalledOnce());
  });

  it("remembers Reject across page changes, but new evidence and a new visit can propose again", () => {
    const content = (key: string | null) => (
      <SuggestionVisitProvider>
        {key ? (
          <SuggestionReview
            suggestion={suggestion}
            currentValue="materials"
            questionKey={key}
            onApply={() => {}}
          />
        ) : null}
      </SuggestionVisitProvider>
    );
    const view = render(content("first"));
    fireEvent.click(screen.getByText("Review", { exact: true }));
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    view.rerender(content(null));
    view.rerender(content("first"));
    expect(screen.queryByText("Tools")).not.toBeInTheDocument();
    view.rerender(content("changed"));
    expect(screen.getByText("Tools")).toBeInTheDocument();
    view.unmount();
    render(content("first"));
    expect(screen.getByText("Tools")).toBeInTheDocument();
  });
});
