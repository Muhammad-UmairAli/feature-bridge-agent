"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

export default function CounterDemo() {
  const [count, setCount] = useState(0);

  return (
    <div className="flex flex-col items-center gap-4">
      <div
        className="text-4xl font-mono tabular-nums"
        role="status"
        aria-live="polite"
        aria-label="Counter value"
      >
        {count}
      </div>
      <div className="flex gap-2">
        <Button
          onClick={() => setCount((c) => c - 1)}
          aria-label="Decrement"
        >
          -
        </Button>
        <Button
          onClick={() => setCount((c) => c + 1)}
          aria-label="Increment"
        >
          +
        </Button>
      </div>
    </div>
  );
}
