"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

export default function Demo() {
  const [count, setCount] = useState(() => {
    if (typeof window === "undefined") {
      return 0;
    }

    const storedCount = window.localStorage.getItem("demo:request-79:counter");
    if (storedCount === null) {
      return 0;
    }

    const parsedCount = Number(storedCount);
    return Number.isFinite(parsedCount) ? parsedCount : 0;
  });

  useEffect(() => {
    window.localStorage.setItem("demo:request-79:counter", String(count));
  }, [count]);

  return (
    <section className="mx-auto flex w-full max-w-sm flex-col items-center gap-6 rounded-xl border border-border bg-background p-8 text-foreground">
      <p className="text-sm text-muted-foreground">Current count</p>
      <div
        aria-label="Counter value"
        className="text-5xl font-semibold tabular-nums"
        role="status"
      >
        {count}
      </div>
      <div className="flex items-center gap-3">
        <Button
          aria-label="Decrement counter"
          onClick={() => setCount((currentCount) => currentCount - 1)}
          variant="outline"
          size="lg"
        >
          -
        </Button>
        <Button
          aria-label="Increment counter"
          onClick={() => setCount((currentCount) => currentCount + 1)}
          size="lg"
        >
          +
        </Button>
      </div>
    </section>
  );
}
