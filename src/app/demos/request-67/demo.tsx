"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export default function CounterDemo() {
  const [count, setCount] = useState(0);

  const increment = () => setCount((c) => c + 1);
  const decrement = () => setCount((c) => c - 1);

  return (
    <div className={cn("flex items-center gap-4")}>
      <Button
        aria-label="decrement"
        onClick={decrement}
        variant="outline"
        size="default"
      >
        -
      </Button>
      <span className={cn("text-2xl font-mono")}>{count}</span>
      <Button
        aria-label="increment"
        onClick={increment}
        variant="outline"
        size="default"
      >
        +
      </Button>
    </div>
  );
}
