import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIdleTimer } from "./idle_timer";

const MIN = 60_000;
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("idle timer", () => {
  it("fires once after the idle time and not again", () => {
    const onIdle = vi.fn();
    createIdleTimer({ minutes: 5, onIdle });
    vi.advanceTimersByTime(5 * MIN - 1);
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onIdle).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60 * MIN);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it("activity pushes the deadline back", () => {
    const onIdle = vi.fn();
    const timer = createIdleTimer({ minutes: 1, onIdle });
    vi.advanceTimersByTime(50_000);
    timer.activity();
    vi.advanceTimersByTime(50_000);
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(10_000);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it("activity after it fired does not revive it", () => {
    const onIdle = vi.fn();
    const timer = createIdleTimer({ minutes: 1, onIdle });
    vi.advanceTimersByTime(MIN);
    timer.activity();
    vi.advanceTimersByTime(5 * MIN);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it("Never (0) never fires", () => {
    const onIdle = vi.fn();
    const timer = createIdleTimer({ minutes: 0, onIdle });
    timer.activity();
    vi.advanceTimersByTime(24 * 60 * MIN);
    expect(onIdle).not.toHaveBeenCalled();
  });

  it("a changed setting restarts the countdown with the new value", () => {
    const onIdle = vi.fn();
    const timer = createIdleTimer({ minutes: 15, onIdle });
    vi.advanceTimersByTime(10 * MIN);
    timer.setMinutes(1);
    vi.advanceTimersByTime(MIN - 1);
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it("switching to Never cancels a pending lock, and back to a number arms it again", () => {
    const onIdle = vi.fn();
    const timer = createIdleTimer({ minutes: 1, onIdle });
    timer.setMinutes(0);
    vi.advanceTimersByTime(10 * MIN);
    expect(onIdle).not.toHaveBeenCalled();
    timer.setMinutes(5);
    vi.advanceTimersByTime(5 * MIN);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it("stop cancels it", () => {
    const onIdle = vi.fn();
    createIdleTimer({ minutes: 1, onIdle }).stop();
    vi.advanceTimersByTime(10 * MIN);
    expect(onIdle).not.toHaveBeenCalled();
  });

  it("many activity calls keep only one timer pending", () => {
    const timer = createIdleTimer({ minutes: 1, onIdle: vi.fn() });
    for (let i = 0; i < 1000; i++) timer.activity();
    expect(vi.getTimerCount()).toBe(1);
  });
});
