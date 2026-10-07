import { act, render, screen } from "@testing-library/react";
import { StrictMode, createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TURNSTILE_ACTION } from "@/lib/bot-check/turnstile-shared";

import { BotCheck, type BotCheckHandle } from "./bot-check";

type RenderOptions = {
  callback: (token: string) => void;
  "expired-callback": () => void;
  action: string;
  theme: string;
  sitekey: string;
};

function stubTurnstile() {
  const api = {
    render: vi.fn((_el: HTMLElement, options: RenderOptions) => {
      options.callback("XXXX.DUMMY.TOKEN.XXXX");
      return "widget-1";
    }),
    reset: vi.fn(),
    remove: vi.fn(),
  };
  window.turnstile = api;
  return api;
}

const scripts = () =>
  document.head.querySelectorAll<HTMLScriptElement>('script[src*="challenges.cloudflare.com"]');

afterEach(() => {
  delete window.turnstile;
  scripts().forEach((script) => script.remove());
  document.documentElement.removeAttribute("data-theme");
});

describe("BotCheck", () => {
  it("explains when no site key is configured", () => {
    render(<BotCheck siteKey={undefined} onToken={vi.fn()} />);
    expect(screen.getByText(/isn't configured/)).toBeInTheDocument();
  });

  it("renders the widget for the submit action in the current theme and passes the token on", async () => {
    const api = stubTurnstile();
    document.documentElement.dataset.theme = "light";
    const onToken = vi.fn();
    render(<BotCheck siteKey="1x00000000000000000000AA" onToken={onToken} describedBy="err" />);
    await act(async () => {});
    const group = screen.getByRole("group", { name: "Verification" });
    expect(group).toHaveAttribute("aria-describedby", "err");
    expect(api.render.mock.calls[0][1]).toMatchObject({
      sitekey: "1x00000000000000000000AA",
      action: TURNSTILE_ACTION,
      theme: "light",
    });
    expect(onToken).toHaveBeenCalledWith("XXXX.DUMMY.TOKEN.XXXX");
  });

  it("renders a single widget under StrictMode's double mount", async () => {
    const api = stubTurnstile();
    render(
      <StrictMode>
        <BotCheck siteKey="key" onToken={vi.fn()} />
      </StrictMode>,
    );
    await act(async () => {});
    expect(api.render.mock.calls.length - api.remove.mock.calls.length).toBe(1);
  });

  it("clears the token when it expires", async () => {
    const api = stubTurnstile();
    const onToken = vi.fn();
    render(<BotCheck siteKey="key" onToken={onToken} />);
    await act(async () => {});
    act(() => api.render.mock.calls[0][1]["expired-callback"]());
    expect(onToken).toHaveBeenLastCalledWith(null);
  });

  it("resets to a fresh token on request and removes the widget on unmount", async () => {
    const api = stubTurnstile();
    const onToken = vi.fn();
    const ref = createRef<BotCheckHandle>();
    const { unmount } = render(<BotCheck ref={ref} siteKey="key" onToken={onToken} />);
    await act(async () => {});
    act(() => ref.current?.reset());
    expect(onToken).toHaveBeenLastCalledWith(null);
    expect(api.reset).toHaveBeenCalledWith("widget-1");
    unmount();
    expect(api.remove).toHaveBeenCalledWith("widget-1");
  });

  it("doesn't render a widget if unmounted before the script loads", async () => {
    const { unmount } = render(<BotCheck siteKey="key" onToken={vi.fn()} />);
    const [script] = scripts();
    unmount();
    const api = stubTurnstile();
    await act(async () => {
      script.onload?.(new Event("load"));
    });
    expect(api.render).not.toHaveBeenCalled();
  });

  it("announces a load failure and retries with a fresh script on the next mount", async () => {
    const first = render(<BotCheck siteKey="key" onToken={vi.fn()} />);
    const [script] = scripts();
    await act(async () => {
      script.onload?.(new Event("load")); // loaded, but no API present
    });
    expect(screen.getByRole("alert")).toHaveTextContent(/couldn't load/);
    expect(scripts()).toHaveLength(0);
    first.unmount();

    render(<BotCheck siteKey="key" onToken={vi.fn()} />);
    expect(scripts()).toHaveLength(1);
  });
});
